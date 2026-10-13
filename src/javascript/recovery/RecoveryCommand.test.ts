import { readLinuxResourceLimits } from "../../process/LinuxResourceLimits.js";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { ProviderProcessSupervisor } from "../../process/ProviderProcess.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { runRecoveryCommand } from "./RecoveryCommand.js";
import type { RecoveryLauncher } from "./RecoveryEngine.js";
import { resolveWakaruCommand } from "./WakaruCommand.js";
import { WAKARU_LIMITS } from "./WakaruRelease.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

const wakaru = {
  providerId: "wakaru",
  name: "Wakaru",
  limits: WAKARU_LIMITS,
  readLimits: async (
    configured: Parameters<typeof readLinuxResourceLimits>[0],
  ) => configured,
  sha256: "0".repeat(64),
  bytes: 0,
  snapshots: [],
};
const expired = () => ({
  at: performance.now() - 1,
  timeoutMs: WAKARU_LIMITS.timeoutMs,
});

it("names the Wakaru configuration requirement when it is not configured", async () => {
  const refusal: unknown = await resolveWakaruCommand({}).catch(
    (cause: unknown) => cause,
  );

  if (!(refusal instanceof AnalysisCapabilityUnavailableError))
    throw new Error("Expected a capability refusal");
  expect(refusal.reason).toContain("REA_WAKARU_COMMAND");
  expect(projectAnalysisError(refusal)).toMatchObject({
    code: "capability_unavailable",
    message: refusal.reason,
    remediation: { action: refusal.reason },
  });
});

it("rejects an exhausted shared execution budget before launching the next command", async () => {
  await expect(
    runRecoveryCommand({
      ...wakaru,
      command: "/selected/wakaru",
      limiter: "/usr/bin/prlimit",
      arguments: ["--version"],
      cwd: "/tmp/unused",
      environment: {},
      deadline: expired(),
      launcher: async () => {
        throw new Error("An expired budget must not launch");
      },
    }),
  ).rejects.toMatchObject({
    _tag: "AnalysisTimeoutError",
    operation: "recover_javascript_sources",
  });
});

it("preserves caller cancellation before acquiring an expired execution budget", async () => {
  await expect(
    runRecoveryCommand({
      ...wakaru,
      command: "/selected/wakaru",
      limiter: "/usr/bin/prlimit",
      arguments: ["--version"],
      cwd: "/tmp/unused",
      environment: {},
      deadline: expired(),
      signal: AbortSignal.abort(),
      launcher: async () => {
        throw new Error("A cancelled request must not launch");
      },
    }),
  ).rejects.toMatchObject({ _tag: "AnalysisCancelledError" });
});

const commandFixture = async (
  emit: (producer: ReturnType<typeof createProducer>) => void,
) => {
  const cwd = await createTestTempDirectory("rea-recovery-command-");
  const producer = createProducer();
  const launcher: RecoveryLauncher = async (options) => {
    setImmediate(() => emit(producer));
    return {
      process: producer,
      ownership: {
        runId: options.runId,
        leaderPid: 12345,
        processGroupId: 12345,
        expectedParentPid: process.pid,
      },
      cleanup: async () => ({ cleaned: true, signaled: false }),
    };
  };
  return {
    producer,
    context: {
      ...wakaru,
      command: "/selected/wakaru",
      limiter: "/usr/bin/prlimit",
      arguments: ["--version"],
      cwd,
      environment: {},
      deadline: {
        at: performance.now() + 5_000,
        timeoutMs: WAKARU_LIMITS.timeoutMs,
      },
      launcher,
    },
  };
};

const createProducer = () =>
  Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => false,
  });

it("retains stdout and stderr delivered after launcher exit", async () => {
  const { context } = await commandFixture((producer) => {
    producer.stdout.write("first");
    producer.emit("exit", 0, null);
    setImmediate(() => {
      producer.stdout.end("last");
      producer.stderr.end("diagnostic");
      producer.emit("close", 0, null);
    });
  });
  await expect(runRecoveryCommand(context)).resolves.toMatchObject({
    exit_code: 0,
    signal: null,
    stdout: "firstlast",
    stderr: "diagnostic",
  });
});

it("checks the diagnostic byte limit against output delivered after exit", async () => {
  const { context } = await commandFixture((producer) => {
    producer.emit("exit", 0, null);
    setImmediate(() => {
      producer.stderr.end(Buffer.alloc(WAKARU_LIMITS.reportBytes + 1, 97));
      producer.stdout.end();
      producer.emit("close", 0, null);
    });
  });
  await expect(runRecoveryCommand(context)).rejects.toMatchObject({
    _tag: "AnalysisOutputError",
    operation: "recover_javascript_sources",
  });
});

it("enforces the shared deadline while exited output streams remain open", async () => {
  const { context, producer } = await commandFixture((process) => {
    process.emit("exit", 0, null);
  });
  try {
    await expect(
      runRecoveryCommand({
        ...context,
        deadline: {
          at: performance.now() + 50,
          timeoutMs: WAKARU_LIMITS.timeoutMs,
        },
      }),
    ).rejects.toMatchObject({
      _tag: "AnalysisTimeoutError",
      operation: "recover_javascript_sources",
    });
    expect(producer.stderr.listenerCount("data")).toBe(0);
  } finally {
    producer.stdout.destroy();
    producer.stderr.destroy();
  }
});

it("honors cancellation while waiting for output after exit", async () => {
  const controller = new AbortController();
  const { context, producer } = await commandFixture((process) => {
    process.emit("exit", 0, null);
    setImmediate(() => controller.abort());
  });
  try {
    await expect(
      runRecoveryCommand({ ...context, signal: controller.signal }),
    ).rejects.toMatchObject({
      _tag: "AnalysisCancelledError",
    });
    expect(producer.stderr.listenerCount("data")).toBe(0);
  } finally {
    producer.stdout.destroy();
    producer.stderr.destroy();
  }
});

it("caps retained diagnostics as a noisy process emits them, while preserving overflow rejection", async () => {
  const snapshots = vi.spyOn(ProviderProcessSupervisor.prototype, "snapshot");
  const { context } = await commandFixture((producer) => {
    producer.stdout.end("0123456789abcdef");
    producer.stderr.end();
    producer.emit("exit", 0, null);
    producer.emit("close", 0, null);
  });
  try {
    await expect(
      runRecoveryCommand({
        ...context,
        limits: { ...context.limits, reportBytes: 4 },
      }),
    ).rejects.toMatchObject({ _tag: "AnalysisOutputError" });
    expect(snapshots).toHaveBeenCalled();
    for (const result of snapshots.mock.results) {
      if (result.type === "return")
        expect(
          Buffer.byteLength(result.value.stdout.text) +
            Buffer.byteLength(result.value.stderr.text),
        ).toBeLessThanOrEqual(8);
    }
  } finally {
    snapshots.mockRestore();
  }
});

it("passes the inherited minima explicitly to both prlimit ceilings", async () => {
  const fixture = await commandFixture((producer) => {
    producer.emit("exit", 0, null);
    producer.stdout.end();
    producer.stderr.end();
    producer.emit("close", 0, null);
  });
  let argumentsSeen: readonly string[] = [];
  const launcher = fixture.context.launcher;
  await runRecoveryCommand({
    ...fixture.context,
    readLimits: async () => ({
      address_space_bytes: 123,
      file_bytes: 456,
      cpu_seconds: 7,
    }),
    launcher: async (options) => {
      argumentsSeen = options.arguments;
      return launcher(options);
    },
  });
  expect(argumentsSeen.slice(0, 4)).toEqual([
    "--as=123:123",
    "--fsize=456:456",
    "--core=0:0",
    "--cpu=7:7",
  ]);
});

it.each([
  { outputBytes: 32, rejected: false },
  { outputBytes: 8, rejected: true },
])(
  "counts workspace temporaries, but not input snapshots, against a $outputBytes-byte output budget",
  async ({ outputBytes, rejected }) => {
    let cwd = "";
    const fixture = await commandFixture((producer) => {
      writeFileSync(join(cwd, "temporary"), "y".repeat(16));
      producer.emit("exit", 0, null);
      producer.stdout.end("1.14.0");
      producer.stderr.end();
      producer.emit("close", 0, null);
    });
    cwd = fixture.context.cwd;
    const snapshot = join(cwd, "inputs", "selected.js");
    mkdirSync(join(cwd, "inputs"));
    writeFileSync(snapshot, "x".repeat(64));
    const run = runRecoveryCommand({
      ...fixture.context,
      limits: { ...fixture.context.limits, outputBytes },
      snapshots: [snapshot],
    });
    if (rejected)
      await expect(run).rejects.toMatchObject({
        _tag: "AnalysisOutputError",
        message: expect.stringContaining("Recovery staging exceeds"),
      });
    else await expect(run).resolves.toMatchObject({ exit_code: 0 });
  },
);
