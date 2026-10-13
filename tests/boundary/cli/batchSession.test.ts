import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { expect } from "vitest";
import { UNKNOWN_CONTRACT_EXAMPLES } from "../../../src/contracts/unknownContractExamples.js";
import { peResourceFixture } from "../../../src/native/pe/PeResources.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const record = {
  id: "record",
  tool: "record_unknown",
  arguments: UNKNOWN_CONTRACT_EXAMPLES.record_unknown,
};
const list = { id: "list", tool: "list_unknowns", arguments: {} };
const lines = (output: string) =>
  output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

cliTest(
  "retains typed tool failures and prevents file-ID or implicit-open collisions",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-batch-preflight-");
    const failed = await cli.run({
      arguments: ["batch", "-", "--continue"],
      input: JSON.stringify([
        {
          id: "missing",
          tool: "inspect_pe_resources",
          arguments: { path: join(root, "missing.exe") },
        },
        list,
      ]),
    });
    expect(failed.exitCode).toBe(1);
    const responses = lines(failed.stdout);
    expect(responses).toHaveLength(2);
    expect(JSON.parse(responses[0].result.content[0].text)).toMatchObject({
      error: {
        code: "invalid_request",
        category: "invalid_input",
        details: { operation: "inspect_pe_resources" },
      },
    });
    for (const calls of [
      [
        { ...list, id: "A" },
        { ...list, id: "a" },
      ],
      [
        { ...list, id: 1 },
        { ...list, id: "1" },
      ],
    ]) {
      const collision = await cli.run({
        arguments: ["batch", "-", "--out", join(root, "out")],
        input: JSON.stringify(calls),
      });
      expect(collision.exitCode).toBe(1);
      expect(await readdir(root)).toEqual([]);
    }
    const implicit = await cli.run({
      arguments: ["batch", "-", "--target", join(root, "absent.exe")],
      input: JSON.stringify([{ ...list, id: "batch-open" }]),
    });
    expect(implicit.exitCode).toBe(1);
    expect(lines(implicit.stdout)[0].error.message).toContain(
      "IDs must be unique",
    );
  },
);

cliTest(
  "rejects incompatible global output controls before reading stdin",
  async ({ cli }) => {
    for (const controls of [
      ["--json"],
      ["--filter-output", "result"],
      ["--token-count"],
      ["--full-output"],
    ]) {
      const result = await cli.run({
        arguments: ["batch", "-", ...controls],
        input: "not JSON",
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        ok: false,
        error: { code: "UNSUPPORTED_OUTPUT_COMBINATION" },
      });
    }
  },
);

cliTest(
  "preserves caller order and session records for file and stdin input",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-batch-session-");
    const path = join(root, "calls.json");
    const text = JSON.stringify([record, list]);
    await writeFile(path, text);
    for (const arguments_ of [
      ["batch", path],
      ["batch", "-", "--jsonl"],
    ]) {
      const result = await cli.run({ arguments: arguments_, input: text });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const responses = lines(result.stdout);
      expect(responses.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: "record", status: "ok" },
        { id: "list", status: "ok" },
      ]);
      expect(responses[1].result.result).toMatchObject({
        total: 1,
      });
      expect(responses.every(({ duration_ms }) => duration_ms >= 0)).toBe(true);
    }
  },
);

cliTest(
  "retains exact tool error documents and distinguishes stop from continue",
  async ({ cli }) => {
    const bad = { id: "bad", tool: "record_unknown", arguments: {} };
    const calls = JSON.stringify([record, bad, list]);
    for (const policy of [[], ["--stop-on-error"], ["--continue"]]) {
      const result = await cli.run({
        arguments: ["batch", "-", ...policy],
        input: calls,
      });
      expect(result.exitCode).toBe(1);
      const responses = lines(result.stdout);
      expect(responses.map(({ id }) => id)).toEqual(
        policy.includes("--continue")
          ? ["record", "bad", "list"]
          : ["record", "bad"],
      );
      expect(responses[1]).toMatchObject({
        status: "error",
        result: { isError: true },
      });
      expect(responses[1].result.content[0].text).toContain("Input validation");
    }
  },
);

cliTest(
  "continues after a protocol-level unknown tool failure",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: ["batch", "-", "--continue"],
      input: JSON.stringify([
        { id: 1, tool: "no_such_tool", arguments: {} },
        list,
      ]),
    });
    expect(result.exitCode).toBe(1);
    const responses = lines(result.stdout);
    expect(responses).toHaveLength(2);
    expect(responses[0].status).toBe("error");
    expect(responses[1].status).toBe("ok");
  },
);

cliTest(
  "writes individual complete results exclusively and preflights existing files",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-batch-output-");
    const output = join(root, "results");
    const calls = JSON.stringify([record, list]);
    const result = await cli.run({
      arguments: ["batch", "-", "--out", output],
      input: calls,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect((await readdir(output)).sort()).toEqual([
      "list.json",
      "record.json",
    ]);
    expect(
      JSON.parse(await readFile(join(output, "list.json"), "utf8")),
    ).toMatchObject({ id: "list", status: "ok" });
    const original = await readFile(join(output, "record.json"));
    const collision = await cli.run({
      arguments: ["batch", "-", "--out", output],
      input: calls,
    });
    expect(collision.exitCode).toBe(1);
    expect(lines(collision.stdout)).toHaveLength(1);
    expect(await readFile(join(output, "record.json"))).toEqual(original);
  },
);

cliTest.for([
  ["invalid JSON", "[", []],
  ["duplicate IDs", JSON.stringify([record, record]), []],
  ["extra fields", JSON.stringify([{ ...list, extra: true }]), []],
  [
    "conflicting error policies",
    JSON.stringify([list]),
    ["--continue", "--stop-on-error"],
  ],
  [
    "conflicting destinations",
    JSON.stringify([list]),
    ["--jsonl", "--out", "/unused"],
  ],
] as const)(
  "rejects %s before dispatch",
  async ([_name, input, options], { cli }) => {
    const result = await cli.run({
      arguments: ["batch", "-", ...options],
      input,
    });
    expect(result.exitCode).toBe(1);
    expect(lines(result.stdout)).toHaveLength(1);
    expect(lines(result.stdout)[0]).toMatchObject({
      id: null,
      status: "error",
      error: { category: "invalid_input" },
    });
  },
);

cliTest.for(["../escape", "CON", "x.", "A/a"])(
  "rejects nonportable output ID %s",
  async (id, { cli }) => {
    const root = await createTestTempDirectory("rea-batch-id-");
    const result = await cli.run({
      arguments: ["batch", "-", "--out", join(root, "out")],
      input: JSON.stringify([{ ...list, id }]),
    });
    expect(result.exitCode).toBe(1);
    expect(await readdir(root)).toEqual([]);
  },
);

cliTest(
  "retains offline Evidence across queries without opening a target",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-batch-evidence-");
    const path = join(root, "owned.exe");
    await writeFile(path, peResourceFixture().bytes);
    const result = await cli.run({
      arguments: ["batch", "-"],
      input: JSON.stringify([
        { id: "pe", tool: "inspect_pe_resources", arguments: { path } },
        { id: "bundle", tool: "get_evidence_bundle", arguments: {} },
      ]),
    });
    expect(result.exitCode).toBe(0);
    const responses = lines(result.stdout);
    expect(responses[0].status).toBe("ok");
    const evidence = responses[0].result;
    expect(responses[0]._meta).toMatchObject({
      provenance: {
        untrusted_content: true,
        source: "analysis_target",
      },
    });
    expect(responses[1].result.result.records).toEqual([evidence]);
  },
);

cliTest.runIf(process.platform !== "win32")(
  "cancels a stdin wait without acquiring a session",
  async ({ processes }) => {
    const runner = `
      import { createCli } from ${JSON.stringify(new URL("../../../dist/cli.js", import.meta.url).href)};
      const iterate = process.stdin[Symbol.asyncIterator];
      process.stdin[Symbol.asyncIterator] = function () {
        process.stdout.write("BATCH_READY\\n");
        return iterate.call(this);
      };
      await createCli({}).serve(["batch", "-"], { exit: code => { process.exitCode = code; } });
    `;
    const child = processes.spawn(
      process.execPath,
      ["--input-type=module", "-e", runner],
      { env: { PATH: process.env.PATH } },
    );
    let stdout = "";
    child.stdout.on("data", (bytes: Buffer) => {
      stdout += bytes.toString();
    });
    const closed = once(child, "close");
    await once(child.stdout, "data");
    expect(stdout).toContain("BATCH_READY\n");
    child.kill("SIGTERM");
    await closed;
    expect(child.exitCode).toBe(143);
    expect(lines(stdout.replace("BATCH_READY\n", ""))[0]).toMatchObject({
      status: "error",
      error: { category: "cancelled" },
    });
  },
);
