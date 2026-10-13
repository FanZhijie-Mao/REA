import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createAnalysisExecution } from "../../application/AnalysisProvider.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import {
  javascriptRecoveryResultSchema,
  type JavaScriptRecoveryInput,
  type JavaScriptRecoveryResult,
} from "../../domain/javascript/javascriptRecovery.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import {
  recoveryToolConfigured,
  resolveRecoveryTool,
  runRecoveryCommand,
} from "./RecoveryCommand.js";
import type { RecoveryEngine, RecoveryWorkspace } from "./RecoveryEngine.js";
import { aliasWarnings, moduleNames } from "./JsBeautifyModuleNames.js";
import {
  fingerprintRecoveryFile,
  readRecoveryFile,
  recoveryDigest,
  recoveryInputFailure,
} from "./RecoveryFiles.js";
import {
  JSBEAUTIFY_LIMITATIONS,
  JSBEAUTIFY_LIMITS,
  JSBEAUTIFY_PROVIDER_IDENTITY,
} from "./JsBeautifyRelease.js";

const OPERATION = "recover_javascript_sources";
const REQUIREMENT =
  "Provide an absolute REA_JSBEAUTIFY_COMMAND pointing to a jsbeautify binary on Linux; no tool is installed by REA. See docs/javascript-recovery.md#jsbeautify.";
const JSBEAUTIFY_SUPPORTED = process.platform === "linux";
const REPARSE_PHASES = ["19.6", "21.5"] as const;
/** The version is embedded in inline Evidence, the manifest and provenance. */
const VERSION_MAX_LENGTH = 128;
const EXCERPT_MAX_LENGTH = 512;

const excerpt = (text: string): string =>
  text.length <= EXCERPT_MAX_LENGTH
    ? text
    : `${text.slice(0, EXCERPT_MAX_LENGTH)}… (${String(Buffer.byteLength(text))} bytes)`;
const LEVEL_ARGUMENTS = {
  minimal: [],
  standard: ["--deobfuscate"],
  aggressive: ["--rename-vars"],
} as const satisfies Record<
  JavaScriptRecoveryInput["rewrite_level"],
  readonly string[]
>;

type CommandResult = Awaited<ReturnType<typeof runRecoveryCommand>>;
type JsBeautifyRunReport = {
  readonly module: string;
  readonly input: string;
  readonly arguments: readonly string[];
} & ReturnType<typeof gate>;

/** The parse goal of the original file; snapshots of a single input lose its extension. */
const sourceTypeArguments = (path: string): readonly string[] =>
  path.endsWith(".cjs")
    ? ["--source-type", "commonjs"]
    : path.endsWith(".mjs")
      ? ["--source-type", "module"]
      : [];

/** Validity gate read from jsbeautify's stderr phase log. */
const gate = (run: CommandResult, deobfuscated: boolean) => {
  const reparse = Object.fromEntries(
    REPARSE_PHASES.map((phase) => [
      phase,
      run.stderr.includes(
        `[DEOBFUSCATE] Phase ${phase}: Generated output re-parse succeeded`,
      ),
    ]),
  );
  const passed =
    run.exit_code === 0 &&
    run.signal === null &&
    (!deobfuscated || REPARSE_PHASES.every((phase) => reparse[phase]));
  return { passed, exit_code: run.exit_code, signal: run.signal, reparse };
};

/** Bundler and obfuscator detections from the phase log's `<name> check: detected …` lines. */
const DETECTORS = [
  [/esbuild\/Bun runtime check: detected ([\w.-]+) runtime/, null],
  [/webpack check: detected webpack/, "webpack"],
  [/Turbopack check: detected/, "turbopack"],
  [/Akamai BMP check: detected/, "akamai-bmp"],
  [/Angular check: detected/, "angular"],
] as const;

const detections = (stderr: string): string[] => {
  const found = new Set<string>();
  for (const [pattern, name] of DETECTORS) {
    const match = pattern.exec(stderr);
    const detected = name ?? match?.[1];
    if (match !== null && detected !== undefined) found.add(detected);
  }
  return [...found];
};

/** Keep the phase summary and failures, or all of a failed run's stderr; drop per-rewrite chatter. */
const phaseLog = (
  stderr: string,
  budget: number,
  complete: boolean,
): string => {
  // One bounded byte buffer avoids an array/string object per stderr line.
  let retained: Buffer | undefined;
  let written = 0;
  for (let start = 0; start < stderr.length;) {
    const newline = stderr.indexOf("\n", start);
    const end = newline < 0 ? stderr.length : newline;
    const line = stderr.slice(start, end);
    start = end + 1;
    if (
      !complete &&
      !line.startsWith("[DEOBFUSCATE] Phase") &&
      !line.startsWith("[AKAMAI]") &&
      !/\b(error|panicked|warning)\b/i.test(line)
    )
      continue;
    const separator = written === 0 ? 0 : 1;
    const bytes = Buffer.byteLength(line);
    if (bytes + separator > budget - written)
      throw new AnalysisOutputError(
        OPERATION,
        "Combined phase reports exceed the retained diagnostic budget",
      );
    retained ??= Buffer.alloc(Math.min(Buffer.byteLength(stderr), budget));
    if (separator !== 0) retained[written++] = 0x0a;
    written += retained.write(line, written, bytes, "utf8");
  }
  return retained?.toString("utf8", 0, written) ?? "";
};

/** The phase report of one operation, bounded across all of its invocations. */
const createPhaseReport = () => {
  const logs: string[] = [];
  let retainedBytes = 0;
  const overflow = () =>
    new AnalysisOutputError(
      OPERATION,
      "Combined phase reports exceed the retained diagnostic budget",
    );
  return {
    retain(heading: string, stderr: string, complete: boolean): void {
      const remaining =
        JSBEAUTIFY_LIMITS.reportBytes -
        retainedBytes -
        Buffer.byteLength(heading) -
        2;
      if (remaining < 0) throw overflow();
      const log = heading + phaseLog(stderr, remaining, complete);
      const logBytes = Buffer.byteLength(log) + 2;
      if (logBytes > JSBEAUTIFY_LIMITS.reportBytes - retainedBytes)
        throw overflow();
      retainedBytes += logBytes;
      logs.push(log);
    },
    text: (): string => `${logs.join("\n\n")}\n`,
  };
};

const executeJsBeautify = async (context: RecoveryWorkspace) => {
  const { root, tree, input, sources, tool, environment, launcher, options } =
    context;
  const signal = options?.signal;
  const command = {
    ...tool,
    providerId: JSBEAUTIFY_PROVIDER_IDENTITY.id,
    name: JSBEAUTIFY_PROVIDER_IDENTITY.name,
    limits: JSBEAUTIFY_LIMITS,
    cwd: root,
    deadline: context.deadline,
    environment,
    snapshots: sources.map((source) => source.snapshot_path),
    ...(signal === undefined ? {} : { signal }),
    ...(launcher === undefined ? {} : { launcher }),
  };
  const banner = await runRecoveryCommand({
    ...command,
    arguments: ["--version"],
  });
  const version = new RegExp(
    `^jsbeautify (\\S{1,${String(VERSION_MAX_LENGTH)}})$`,
  ).exec(banner.stdout.trim())?.[1];
  if (banner.exit_code !== 0 || version === undefined) {
    const reason = `jsbeautify --version did not report a version of at most ${String(VERSION_MAX_LENGTH)} characters; stdout: ${excerpt(banner.stdout.trim())}; exit: ${String(banner.exit_code)}`;
    throw new AnalysisCapabilityUnavailableError(
      JSBEAUTIFY_PROVIDER_IDENTITY.id,
      OPERATION,
      `${reason}; stderr: ${excerpt(banner.stderr)}`,
      { userMessage: `${reason}.` },
    );
  }
  const phases = createPhaseReport();
  // Inline Evidence keeps the parsed version; the banner's diagnostics stay in the report.
  if (banner.stderr !== "")
    phases.retain("# jsbeautify --version\n", banner.stderr, true);
  let publishedBytes = 0;
  const write = async (path: string, bytes: Buffer) => {
    if (bytes.byteLength > JSBEAUTIFY_LIMITS.outputBytes - publishedBytes)
      throw new AnalysisOutputError(
        OPERATION,
        "Published recovery artifacts exceed the operation-wide output budget",
      );
    const file = await tree.write(
      path,
      Readable.from([bytes]),
      { sha256: recoveryDigest(bytes), bytes: bytes.byteLength },
      signal,
    );
    publishedBytes += file.bytesWritten;
    return {
      path: join(tree.outputRoot, file.relativePath),
      sha256: file.sha256,
      bytes: file.bytesWritten,
    };
  };
  const deobfuscated = input.rewrite_level !== "minimal";
  const names = moduleNames(sources);
  const published: JavaScriptRecoveryResult["source"][] = [];
  const modules: JavaScriptRecoveryResult["modules"] = [];
  const warnings: JavaScriptRecoveryResult["warnings"] = [];
  const runs: JsBeautifyRunReport[] = [];
  const formats = new Set<string>();
  for (const [sourceIndex, source] of sources.entries()) {
    const snapshot = await readRecoveryFile(
      source.snapshot_path,
      source.bytes,
      signal,
    );
    if (recoveryDigest(snapshot) !== source.sha256)
      throw new AnalysisOutputError(
        OPERATION,
        `The input snapshot changed during recovery: ${source.path}`,
      );
    const { relative_path, ...selected } = source;
    published.push({
      ...selected,
      published_copy: await write(`inputs/${relative_path}`, snapshot),
    });
    const name = names[sourceIndex]?.name;
    if (name === undefined)
      throw new AnalysisOutputError(OPERATION, "Missing allocated module name");
    const output = join(root, "modules", name);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    const argumentsList = [
      source.snapshot_path,
      "--output",
      output,
      "--quiet",
      ...LEVEL_ARGUMENTS[input.rewrite_level],
      ...sourceTypeArguments(source.path),
    ];
    const run = await runRecoveryCommand({
      ...command,
      arguments: argumentsList,
    });
    const consumed = await fingerprintRecoveryFile(
      source.snapshot_path,
      source.bytes,
      signal,
    );
    if (consumed.sha256 !== source.sha256 || consumed.bytes !== source.bytes)
      throw new AnalysisOutputError(
        OPERATION,
        `The input snapshot changed during recovery: ${source.path}`,
      );
    const verdict = gate(run, deobfuscated);
    for (const format of detections(run.stderr)) formats.add(format);
    phases.retain(`# ${JSON.stringify(name)}\n`, run.stderr, !verdict.passed);
    if (!verdict.passed && run.stdout !== "")
      phases.retain(`# ${JSON.stringify(name)} stdout\n`, run.stdout, true);
    runs.push({
      module: name,
      input: source.snapshot_path,
      arguments: argumentsList,
      ...verdict,
    });
    if (!verdict.passed) {
      warnings.push({
        filename: name,
        kind: "validity-gate",
        is_error: true,
        message: `jsbeautify exit ${String(run.exit_code)}${run.signal === null ? "" : ` (signal ${run.signal})`}; re-parse ${REPARSE_PHASES.map((phase) => `${phase}=${String(verdict.reparse[phase])}`).join(", ")}; the output was not published; its complete stderr and stdout are in reports/phases.log`,
      });
      continue;
    }
    modules.push({
      reported_filename: name,
      reported_status: deobfuscated ? "deobfuscated" : "formatted",
      artifact: await write(
        `modules/${name}`,
        await readRecoveryFile(
          output,
          JSBEAUTIFY_LIMITS.outputBytes - publishedBytes,
          signal,
        ),
      ),
      source_map: null,
      provenance: {
        reported_input: source.snapshot_path,
        original_path: source.path,
        original_sha256: source.sha256,
        extraction: "whole-file",
        byte_ranges: [{ start: 0, end: source.bytes }],
        context_byte_ranges: [],
        range_semantics: "half-open-utf8-bytes",
      },
    });
  }
  const failed = warnings.length;
  const aliases = aliasWarnings(sources, names);
  warnings.push(...aliases);
  const [source, ...additionalSources] = published;
  if (source === undefined)
    throw new AnalysisOutputError(OPERATION, "Recovery selected no input");
  const report = await write("reports/phases.log", Buffer.from(phases.text()));
  const provenance = await write(
    "reports/provenance.json",
    Buffer.from(
      `${JSON.stringify({ engine: "jsbeautify", version, resource_limiter: tool.limiter, runs }, null, 2)}\n`,
    ),
  );
  const details = {
    source,
    ...(additionalSources.length === 0
      ? {}
      : { additional_sources: additionalSources }),
    engine: {
      id: JSBEAUTIFY_PROVIDER_IDENTITY.id,
      version,
      executable: {
        path: tool.command,
        sha256: tool.sha256,
        bytes: tool.bytes,
      },
      audited_source_revision: null,
      executed_source_revision: null,
    },
    options: {
      extraction_mode: input.extraction_mode,
      rewrite_level: input.rewrite_level,
    },
    status: failed === 0 ? ("complete" as const) : ("partial" as const),
    detected_formats: [...formats],
    reported_safety:
      modules.length === 0
        ? "No output passed the validity gate; no generated output was published"
        : deobfuscated
          ? "Published modules only: rewritten; generated output re-parsed"
          : "Published modules only: formatted; layout verified by jsbeautify",
    reported_strategy: deobfuscated
      ? `jsbeautify ${LEVEL_ARGUMENTS[input.rewrite_level].join(" ")}`
      : "jsbeautify",
    reported_format: "per-file",
    total: sources.length,
    failed,
    modules,
    warnings,
    report,
    provenance,
    analysis_input:
      modules.length === 0 || aliases.length !== 0
        ? null
        : {
            input_path: join(tree.outputRoot, "modules"),
            format: "directory" as const,
          },
    runtime_equivalence: "unknown" as const,
    limitations: [...JSBEAUTIFY_LIMITATIONS],
  };
  const manifest = await write(
    "manifest.json",
    Buffer.from(`${JSON.stringify(details, null, 2)}\n`),
  );
  return {
    result: javascriptRecoveryResultSchema.parse({ ...details, manifest }),
    banner: {
      arguments: banner.arguments,
      exit_code: banner.exit_code,
      signal: banner.signal,
      version,
    },
    runs,
    version,
  };
};

/** Run, publish, then prove the originals and the engine did not change meanwhile. */
const prepareJsBeautifyExecution = async (context: RecoveryWorkspace) => {
  const { sources, tool, options } = context;
  const { result, banner, runs, version } = await executeJsBeautify(context);
  for (const selected of sources) {
    const current = await fingerprintRecoveryFile(
      selected.path,
      JSBEAUTIFY_LIMITS.inputBytes,
      options?.signal,
    );
    if (current.sha256 !== selected.sha256 || current.bytes !== selected.bytes)
      throw new AnalysisOutputError(
        OPERATION,
        `Original input changed during recovery: ${selected.path}`,
      );
  }
  if (
    (
      await fingerprintRecoveryFile(
        tool.command,
        JSBEAUTIFY_LIMITS.outputBytes,
        options?.signal,
      )
    ).sha256 !== tool.sha256
  )
    throw new AnalysisOutputError(
      OPERATION,
      "Configured engine bytes changed during recovery",
    );
  const [source] = sources;
  return createAnalysisExecution(
    result,
    { ...JSBEAUTIFY_PROVIDER_IDENTITY, version },
    {
      rawResult: jsonValueSchema.parse({
        version: banner,
        resource_limiter: tool.limiter,
        runs,
      }),
      subject: {
        path: source.path,
        sha256: source.sha256,
        format: "javascript",
      },
      locations: [
        ...sources.map((selected) => ({
          kind: "artifact-path" as const,
          path: selected.path,
        })),
        ...result.modules.map((module) => ({
          kind: "artifact-path" as const,
          path: module.artifact.path,
        })),
      ],
      limitations: result.limitations,
    },
  );
};

/** jsbeautify: per-file formatting or deobfuscation behind a re-parse gate. */
export const jsbeautifyEngine: RecoveryEngine = {
  id: "jsbeautify",
  limits: JSBEAUTIFY_LIMITS,
  validate: (input) =>
    input.extraction_mode === "structural"
      ? undefined
      : recoveryInputFailure(
          "extraction_mode",
          "jsbeautify recovers each selected file whole; only extraction_mode structural applies",
        ),
  configured: (environment) =>
    recoveryToolConfigured(
      JSBEAUTIFY_SUPPORTED,
      environment.REA_JSBEAUTIFY_COMMAND,
    ),
  resolve: (environment) =>
    resolveRecoveryTool(environment, {
      id: JSBEAUTIFY_PROVIDER_IDENTITY.id,
      name: JSBEAUTIFY_PROVIDER_IDENTITY.name,
      configured: environment.REA_JSBEAUTIFY_COMMAND,
      supported: JSBEAUTIFY_SUPPORTED,
      requirement: REQUIREMENT,
      limits: JSBEAUTIFY_LIMITS,
    }),
  execute: prepareJsBeautifyExecution,
};
