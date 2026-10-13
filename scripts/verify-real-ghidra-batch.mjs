import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { estimateTokenCount } from "tokenx";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";

const exec = promisify(execFile);
const run = createVerifierRun();
assert.ok(process.platform === "darwin" || process.platform === "linux");
const workspace = await mkdtemp(join(tmpdir(), "rea-ghidra-batch-"));
const runtime = join(workspace, "runtime");
const entrypoint = resolve("scripts/rea.mjs");
const target = resolve("build/fixtures/rea-ghidra-windows-x86.exe");
const calls = join(workspace, "calls.json");
const snapshot = join(workspace, "analysis.json");
const environment = {
  ...process.env,
  TMPDIR: runtime,
  REA_LOG_LEVEL: "silent",
};
let verifiedCleanup = false;

const timed = async (label, arguments_) => {
  const started = performance.now();
  const { stdout, stderr } = await exec(
    "/usr/bin/time",
    [
      process.platform === "darwin" ? "-l" : "-v",
      process.execPath,
      entrypoint,
      ...arguments_,
    ],
    { env: environment, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
  );
  const decimal = (expression) => {
    const match = stderr.match(expression);
    return match === null ? null : Number(match[1]);
  };
  return {
    label,
    stdout,
    measurement: {
      elapsed_ms: performance.now() - started,
      cpu_user_seconds: decimal(
        process.platform === "darwin"
          ? /([\d.]+) user/u
          : /User time \(seconds\): ([\d.]+)/u,
      ),
      cpu_system_seconds: decimal(
        process.platform === "darwin"
          ? /([\d.]+) sys/u
          : /System time \(seconds\): ([\d.]+)/u,
      ),
      peak_individual_rss_bytes:
        process.platform === "darwin"
          ? decimal(/(\d+)\s+maximum resident set size/u)
          : (() => {
              const kb = decimal(
                /Maximum resident set size \(kbytes\): (\d+)/u,
              );
              return kb === null ? null : kb * 1024;
            })(),
      stdout_bytes: Buffer.byteLength(stdout),
      estimated_output_tokens: estimateTokenCount(stdout),
      process_family_peak_memory:
        "not measured; time reports an individual process maximum",
    },
  };
};

try {
  await mkdir(runtime);
  await exec(process.execPath, ["scripts/create-ghidra-windows-fixture.mjs"]);
  const digest = createHash("sha256")
    .update(await readFile(target))
    .digest("hex");
  const requests = [
    {
      id: "function",
      tool: "analyze_function",
      arguments: { procedure: "0x401000" },
    },
    {
      id: "code",
      tool: "procedure_pseudo_code",
      arguments: { procedure: "0x401010" },
    },
    {
      id: "bytes",
      tool: "read_bytes",
      arguments: { address: "0x401000", length: 8 },
    },
  ];
  await writeFile(calls, JSON.stringify(requests));
  const single = [];
  // The first standalone import is a cold workflow. Later imports may benefit
  // from the host's filesystem/JVM caches, but each still owns a fresh provider.
  for (const arguments_ of [
    ["function", target, "0x401000"],
    ["decompile", target, "0x401010"],
    ["read-bytes", target, "0x401000", "--length", "8"],
  ])
    single.push(
      await timed("one-shot", [
        ...arguments_,
        "--provider",
        "ghidra",
        "--json",
      ]),
    );
  const batch = await timed("batch-after-three-one-shots", [
    "batch",
    calls,
    "--target",
    target,
    "--provider",
    "ghidra",
    "--snapshot",
    snapshot,
  ]);
  const records = batch.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map(({ id, status }) => ({ id, status })),
    ["batch-open", ...requests.map(({ id }) => id)].map((id) => ({
      id,
      status: "ok",
    })),
  );
  for (const [index, standalone] of single.entries()) {
    const expected = JSON.parse(standalone.stdout).normalized_result;
    const actual = records[index + 1].result;
    assert.deepEqual(actual.normalized_result, expected);
    assert.equal(actual.subject.digest.sha256, digest);
  }
  const saved = JSON.parse(await readFile(snapshot, "utf8"));
  assert.ok(saved);
  assert.deepEqual(await readdir(runtime), []);
  // Cancellation is tested through the CLI boundary and the existing session
  // lifecycle suite. This lane establishes real provider reuse and cleanup.
  assert.equal(
    createHash("sha256")
      .update(await readFile(target))
      .digest("hex"),
    digest,
  );
  verifiedCleanup = true;
  console.log(
    JSON.stringify({
      status: "passed",
      provider: "Ghidra 12.1.4",
      host: `${process.platform}/${process.arch}`,
      target_sha256: digest,
      standalone: single.map(({ measurement }) => measurement),
      batch: batch.measurement,
      timing_scope:
        "Three fresh standalone imports compared with one batch after host-cache warming; not a controlled cold/warm speed benchmark.",
      token_scope:
        "tokenx estimates output only; no live agent/model or input-schema tokens measured. Successes preserve canonical structured values once with MCP metadata; errors retain their envelopes.",
      checks: [
        "one_open_then_three_calls",
        "equal_normalized_results",
        "snapshot_saved",
        "target_immutable",
        "runtime_cleanup",
      ],
      verifier_run: await completeVerifierRun(run),
    }),
  );
} finally {
  if (verifiedCleanup) await rm(workspace, { recursive: true, force: true });
  else
    console.error(`Verification failed; retained diagnostics at ${workspace}`);
}
