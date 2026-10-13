import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const scenario = vi.hoisted(() => ({
  mutateSnapshot: false,
  rejectArguments: false,
  versionStderr: "",
  versionStdout: "jsbeautify 1.0",
  rejectStdout: "",
}));
beforeEach(() => {
  scenario.mutateSnapshot = false;
  scenario.rejectArguments = false;
  scenario.versionStderr = "";
  scenario.versionStdout = "jsbeautify 1.0";
  scenario.rejectStdout = "";
});

vi.mock(
  "../../../src/javascript/recovery/RecoveryCommand.js",
  async (original) => {
    const actual =
      await original<
        typeof import("../../../src/javascript/recovery/RecoveryCommand.js")
      >();
    return {
      ...actual,
      runRecoveryCommand: async (
        context: Parameters<typeof actual.runRecoveryCommand>[0],
      ) => {
        const version = context.arguments[0] === "--version";
        let stderr = version ? scenario.versionStderr : "";
        if (!version && scenario.rejectArguments)
          return {
            exit_code: 2,
            signal: null,
            stdout: scenario.rejectStdout,
            stderr:
              "invalid option --rename-vars\nUsage: jsbeautify [OPTIONS] <FILE>\n",
            command: context.command,
            arguments: [...context.arguments],
            resource_limiter: context.limiter,
          };
        if (!version) {
          expect(context.snapshots).toContain(context.arguments[0]);
          const source = await readFile(context.arguments[0]!, "utf8");
          if (scenario.mutateSnapshot)
            await writeFile(context.arguments[0]!, "const value = 99;");
          const output =
            context.arguments[context.arguments.indexOf("--output") + 1]!;
          await mkdir(dirname(output), { recursive: true });
          await writeFile(output, "const value = 42;".padEnd(4 * 1024, " "));
          stderr =
            "[DEOBFUSCATE] Phase 19.6: Generated output re-parse succeeded\n" +
            (source.includes("FAIL")
              ? ""
              : "[DEOBFUSCATE] Phase 21.5: Generated output re-parse succeeded");
        }
        return {
          exit_code: 0,
          signal: null,
          stdout: version ? scenario.versionStdout : "",
          stderr,
          command: context.command,
          arguments: [...context.arguments],
          resource_limiter: context.limiter,
        };
      },
    };
  },
);

import { JavaScriptRecoveryService } from "../../../src/application/javascript/JavaScriptRecoveryService.js";
import { jsbeautifyEngine } from "../../../src/javascript/recovery/JsBeautifyEngine.js";
import { RecoveryProvider } from "../../../src/javascript/recovery/RecoveryProvider.js";
import { fingerprintRecoveryFile } from "../../../src/javascript/recovery/RecoveryFiles.js";
import { javascriptRecoveryResultSchema } from "../../../src/domain/javascript/javascriptRecovery.js";

const recover = async (names: string[], failing = false) => {
  const root = await createTestTempDirectory("rea-jsbeautify-publication-");
  const command = join(root, "engine");
  await writeFile(command, "fixture engine");
  const fingerprint = await fingerprintRecoveryFile(command, 16 * 1024);
  const sources = names.map((name) => join(root, name));
  for (const path of sources)
    await writeFile(path, failing ? "FAIL" : "const value = 42;");
  const provider = new RecoveryProvider(
    [
      {
        ...jsbeautifyEngine,
        resolve: async () => ({
          command,
          limiter: "/fixture/prlimit",
          ...fingerprint,
        }),
      },
    ],
    {},
  );
  const service = new JavaScriptRecoveryService(provider);
  try {
    return await service.recover({
      path: sources[0]!,
      additional_paths: sources.slice(1),
      output_directory: join(root, "output"),
      engine: "jsbeautify",
    });
  } finally {
    await provider.close();
  }
};

it.each([{ names: ["bundle"] }, { names: ["bundle", "chunk.data"] }])(
  "publishes extensionless scripts with discoverable JavaScript names: $names",
  async ({ names }) => {
    const evidence = await recover(names);
    if (!evidence.ok) throw evidence.error;
    const result = javascriptRecoveryResultSchema.parse(
      evidence.value.normalized_result,
    );
    expect(result.modules.map((module) => module.reported_filename)).toEqual(
      names.map((name) => `${name}.js`),
    );
    expect(
      result.modules.map((module) =>
        module.provenance.original_path.split("/").at(-1),
      ),
    ).toEqual(names);
  },
);

it.skipIf(process.platform === "win32")(
  "uses the safe snapshot basename for native-only filenames",
  async () => {
    const evidence = await recover(["a\\b.js"]);
    if (!evidence.ok) throw evidence.error;
    const result = javascriptRecoveryResultSchema.parse(
      evidence.value.normalized_result,
    );
    expect(result.modules[0]?.reported_filename).toBe("bundle.js");
  },
);

it("does not claim successful reparsing when every file fails its gate", async () => {
  const evidence = await recover(["a.js", "b.js"], true);
  if (!evidence.ok) throw evidence.error;
  const result = javascriptRecoveryResultSchema.parse(
    evidence.value.normalized_result,
  );
  expect(result.modules).toEqual([]);
  expect(result.analysis_input).toBeNull();
  expect(result.reported_safety).toContain("No output passed");
});

it("allocates distinct discoverable outputs for an extension collision", async () => {
  const evidence = await recover(["bundle", "bundle.js"]);
  if (!evidence.ok) throw evidence.error;
  const result = javascriptRecoveryResultSchema.parse(
    evidence.value.normalized_result,
  );
  expect(result.modules).toHaveLength(2);
  expect(
    new Set(result.modules.map((module) => module.artifact.path)).size,
  ).toBe(2);
  expect(
    result.modules.every((module) => module.reported_filename.endsWith(".js")),
  ).toBe(true);
  expect(
    result.modules.map((module) =>
      module.provenance.original_path.split("/").at(-1),
    ),
  ).toEqual(["bundle", "bundle.js"]);
});

it("refuses output when the engine mutates its input snapshot", async () => {
  scenario.mutateSnapshot = true;
  const evidence = await recover(["a.js"]);
  expect(evidence.ok).toBe(false);
  if (!evidence.ok)
    expect(evidence.error).toMatchObject({
      _tag: "AnalysisOutputError",
      message: expect.stringContaining("input snapshot changed"),
    });
});

it("retains the complete stderr of a rewrite that fails its gate", async () => {
  scenario.rejectArguments = true;
  const evidence = await recover(["a.js"]);
  if (!evidence.ok) throw evidence.error;
  const result = javascriptRecoveryResultSchema.parse(
    evidence.value.normalized_result,
  );
  expect(result.status).toBe("partial");
  const report = await readFile(result.report.path, "utf8");
  expect(report).toContain("invalid option --rename-vars");
  expect(report).toContain("Usage: jsbeautify [OPTIONS] <FILE>");
  expect(result.warnings[0]?.message).toContain("reports/phases.log");
});

it("keeps version diagnostics in the phase report instead of inline Evidence", async () => {
  scenario.versionStderr = "loaded 3 plugins from ~/.jsbeautify\n";
  const evidence = await recover(["a.js"]);
  if (!evidence.ok) throw evidence.error;
  const result = javascriptRecoveryResultSchema.parse(
    evidence.value.normalized_result,
  );
  expect(JSON.stringify(evidence.value)).not.toContain("loaded 3 plugins");
  expect(evidence.value.raw_result).toMatchObject({
    version: { exit_code: 0, version: "1.0" },
  });
  expect(await readFile(result.report.path, "utf8")).toContain(
    "# jsbeautify --version\nloaded 3 plugins from ~/.jsbeautify",
  );
});

it.skipIf(process.platform === "win32")(
  "encodes module names in phase report headings",
  async () => {
    const evidence = await recover(["foo\n# other.js"]);
    if (!evidence.ok) throw evidence.error;
    const result = javascriptRecoveryResultSchema.parse(
      evidence.value.normalized_result,
    );
    const name = result.modules[0]?.reported_filename;
    expect(name).toBe("foo\n# other.js");
    const lines = (await readFile(result.report.path, "utf8")).split("\n");
    expect(lines[0]).toBe(`# ${JSON.stringify(name)}`);
    expect(lines).not.toContain("# other.js");
  },
);

it("does not attribute the configured executable to an audited source", async () => {
  const evidence = await recover(["a.js"]);
  if (!evidence.ok) throw evidence.error;
  const result = javascriptRecoveryResultSchema.parse(
    evidence.value.normalized_result,
  );
  expect(result.engine).toMatchObject({
    version: "1.0",
    audited_source_revision: null,
    executed_source_revision: null,
  });
  expect(JSON.stringify(evidence.value)).not.toContain("github.com");
});

it("keeps natural output names when an extensionless input would take another input's name", async () => {
  const evidence = await recover(["main.cjs", "bundle", "bundle.js"]);
  if (!evidence.ok) throw evidence.error;
  const result = javascriptRecoveryResultSchema.parse(
    evidence.value.normalized_result,
  );
  const byOriginal = Object.fromEntries(
    result.modules.map((module) => [
      module.provenance.original_path.split("/").at(-1),
      module.reported_filename,
    ]),
  );
  expect(byOriginal["main.cjs"]).toBe("main.cjs");
  expect(byOriginal["bundle.js"]).toBe("bundle.js");
  expect(byOriginal["bundle"]).not.toBe("bundle.js");
  expect(byOriginal["bundle"]).toMatch(/\.js$/);
});

it("rejects an unbounded version token without echoing it", async () => {
  scenario.versionStdout = `jsbeautify ${"x".repeat(1024 * 1024)}`;
  const evidence = await recover(["a.js"]);
  expect(evidence.ok).toBe(false);
  if (evidence.ok) return;
  expect(evidence.error).toMatchObject({
    _tag: "AnalysisCapabilityUnavailableError",
  });
  expect(evidence.error.message.length).toBeLessThan(4096);
  expect(evidence.error.userMessage?.length).toBeLessThan(4096);
});

it("retains the stdout of a rewrite that fails its gate", async () => {
  scenario.rejectArguments = true;
  scenario.rejectStdout = "usage: wrapper <file>\n";
  const evidence = await recover(["a.js"]);
  if (!evidence.ok) throw evidence.error;
  const result = javascriptRecoveryResultSchema.parse(
    evidence.value.normalized_result,
  );
  expect(await readFile(result.report.path, "utf8")).toContain(
    "usage: wrapper <file>",
  );
});

it("records the selected resource limiter in recovery provenance", async () => {
  const evidence = await recover(["a.js"]);
  if (!evidence.ok) throw evidence.error;
  const result = javascriptRecoveryResultSchema.parse(
    evidence.value.normalized_result,
  );
  expect(
    JSON.parse(await readFile(result.provenance.path, "utf8")),
  ).toMatchObject({ resource_limiter: "/fixture/prlimit" });
  expect(evidence.value.raw_result).toMatchObject({
    resource_limiter: "/fixture/prlimit",
  });
});

it("does not offer the module tree as analysis input when a module was aliased", async () => {
  const evidence = await recover(["main.cjs", "bundle", "bundle.js"]);
  if (!evidence.ok) throw evidence.error;
  const result = javascriptRecoveryResultSchema.parse(
    evidence.value.normalized_result,
  );
  const aliased = result.modules.find((module) =>
    module.provenance.original_path.endsWith("/bundle"),
  );
  expect(result.modules).toHaveLength(3);
  expect(result.status).toBe("complete");
  expect(result.failed).toBe(0);
  expect(result.analysis_input).toBeNull();
  expect(result.warnings).toEqual([
    expect.objectContaining({
      filename: aliased?.reported_filename,
      kind: "module-alias",
      is_error: false,
    }),
  ]);
  expect(result.warnings[0]?.message).toContain('"bundle"');
});

it("keeps analysis input for a single shortened module, which no other input imports", async () => {
  const evidence = await recover(["n".repeat(253)]);
  if (!evidence.ok) throw evidence.error;
  const result = javascriptRecoveryResultSchema.parse(
    evidence.value.normalized_result,
  );
  expect(result.modules[0]?.reported_filename).toMatch(
    /^__rea_[0-9a-f]{16}\.js$/,
  );
  expect(result.analysis_input).not.toBeNull();
  expect(result.warnings).toEqual([]);
});

it("does not offer the module tree as analysis input when a long name was shortened", async () => {
  // 253 bytes is a valid Linux basename, but with ".js" it exceeds 255 bytes.
  const long = "m".repeat(253);
  const evidence = await recover(["main.cjs", long]);
  if (!evidence.ok) throw evidence.error;
  const result = javascriptRecoveryResultSchema.parse(
    evidence.value.normalized_result,
  );
  const shortened = result.modules.find((module) =>
    module.provenance.original_path.endsWith(`/${long}`),
  );
  expect(shortened?.reported_filename).toMatch(/^__rea_[0-9a-f]{16}\.js$/);
  expect(result.status).toBe("complete");
  expect(result.analysis_input).toBeNull();
  expect(result.warnings).toEqual([
    expect.objectContaining({
      filename: shortened?.reported_filename,
      kind: "module-alias",
      is_error: false,
    }),
  ]);
});
