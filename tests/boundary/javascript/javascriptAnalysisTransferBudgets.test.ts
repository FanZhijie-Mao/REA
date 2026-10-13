import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { analyzeJavaScriptSemantics } from "../../../src/domain/javascript/javascriptSemanticAnalysis.js";
import { projectJavaScriptModuleSemantics } from "../../../src/domain/javascript/javascriptModuleSemanticIr.js";
import type { JavaScriptArtifactFile } from "../../../src/domain/javascript/javascriptArtifactFiles.js";
import { completeJavaScriptAnalysisSteps } from "../../../src/application/javascript/JavaScriptAnalysisControl.js";
import { projectJavaScriptSemanticFileSteps } from "../../../src/application/javascript/JavaScriptSemanticGraphBuilder.js";
import {
  javaScriptTransferByteBudget,
  javaScriptTransferRetentionBytes,
  measureJavaScriptModuleTransfer,
  writeJavaScriptAnalysisTransfer,
  readJavaScriptAnalysisTransfer,
} from "../../../src/javascript/analysis/JavaScriptAnalysisTransfer.js";

it("allows larger streamed transfers only with corresponding parent capacity", () => {
  const mib = 1024 * 1024;
  expect(javaScriptTransferByteBudget(0)).toBe(512 * mib);
  expect(javaScriptTransferByteBudget(4096 * mib)).toBe(
    Math.floor((4096 * mib) / 5),
  );
  expect(javaScriptTransferByteBudget(8192 * mib)).toBe(
    Math.floor((8192 * mib) / 5),
  );
  expect(javaScriptTransferByteBudget(12288 * mib)).toBe(2048 * mib);
  expect(javaScriptTransferByteBudget(32768 * mib)).toBe(2048 * mib);
});

it("enforces the offered complete-file byte budget while preserving authenticated round trips", async () => {
  const root = await createTestTempDirectory("rea-js-transfer-budget-");
  const text = "export function add(value) { return value + 1; }";
  const file: JavaScriptArtifactFile = {
    path: "app.mjs",
    sha256: createHash("sha256").update(text).digest("hex"),
    container_sha256: "a".repeat(64),
    bytes: Buffer.byteLength(text),
    inventory_artifact_id: "fixture-source",
    kind: "javascript",
    unpacked: false,
    text: { included: true, value: text },
  };
  const ir = analyzeJavaScriptSemantics(text);
  const module = projectJavaScriptModuleSemantics(ir);
  const projection = await completeJavaScriptAnalysisSteps(
    projectJavaScriptSemanticFileSteps(file, ir, 100),
  );
  const observed = await writeJavaScriptAnalysisTransfer(
    join(root, "observed"),
    module,
    projection,
  );
  const measured = measureJavaScriptModuleTransfer(module);
  expect(measured).toMatchObject({
    bytes: observed.module_bytes,
    records: observed.module_records,
  });
  expect(measureJavaScriptModuleTransfer(module, measured.bytes)).toEqual(
    measured,
  );
  expect(() =>
    measureJavaScriptModuleTransfer(module, measured.bytes - 1),
  ).toThrowError(
    expect.objectContaining({
      resource: "transport",
      reportedLimits: expect.objectContaining({
        transfer_file_bytes: measured.bytes - 1,
      }),
    }),
  );
  expect(() =>
    measureJavaScriptModuleTransfer(module, 2 ** 31 + 1),
  ).toThrowError(RangeError);
  const exactPath = join(root, "exact");
  const exact = await writeJavaScriptAnalysisTransfer(
    exactPath,
    module,
    projection,
    observed.bytes,
  );
  expect(exact).toEqual(observed);
  expect(await readJavaScriptAnalysisTransfer(exactPath, exact, file)).toEqual({
    module,
    projection,
  });
  await expect(
    writeJavaScriptAnalysisTransfer(
      join(root, "short"),
      module,
      projection,
      observed.bytes - 1,
    ),
  ).rejects.toMatchObject({
    resource: "transport",
    reportedLimits: { transfer_file_bytes: observed.bytes - 1 },
  });
  await expect(
    writeJavaScriptAnalysisTransfer(
      join(root, "oversized"),
      module,
      projection,
      2 ** 31 + 1,
    ),
  ).rejects.toBeInstanceOf(RangeError);
});

it("admits the recorded transfer under the retention policy", () => {
  // Recorded admission refusal (#1387 follow-up): a single 3.2 MB minified
  // source produced a 210,238,252-byte / 260,560-record graph transfer with
  // 1,434,390,040 bytes remaining in the parent budget. The worker and its
  // transfer fit their own budgets; only the retention estimate refused.
  const graphBytes = 210_238_252;
  const graphRecords = 260_560;
  const moduleBytes = 1_892_116;
  const moduleRecords = 2_295;
  const remaining = 1_434_390_040;
  const moduleEstimate = javaScriptTransferRetentionBytes(
    moduleBytes,
    moduleRecords,
  );
  const graphEstimate = javaScriptTransferRetentionBytes(
    graphBytes,
    graphRecords,
  );
  expect(moduleEstimate).toBe(9_607_460);
  expect(graphEstimate).toBe(1_067_867_100);
  // This checks admission policy, not a measured memory bound. Completed
  // process-family measurements live in the transfer-retention experiment.
  // The previous 8x charge refused this transfer against the same budget.
  expect(graphEstimate / graphBytes).toBeGreaterThanOrEqual(5);
  expect(graphEstimate / graphBytes).toBeLessThan(5.5);
  expect(moduleEstimate + graphEstimate).toBeLessThanOrEqual(remaining);
  expect(2 * (moduleEstimate + graphEstimate)).toBeGreaterThan(remaining);
});

it("charges retention monotonically from empty transfers", () => {
  expect(javaScriptTransferRetentionBytes(0, 0)).toBe(0);
  expect(javaScriptTransferRetentionBytes(1, 0)).toBe(5 + 64 * 0);
  expect(javaScriptTransferRetentionBytes(0, 1)).toBe(64);
  const small = javaScriptTransferRetentionBytes(1024, 10);
  const large = javaScriptTransferRetentionBytes(2048, 20);
  expect(large).toBeGreaterThan(small);
  expect(large).toBe(2 * small);
});
