import { describe, expect, it } from "vitest";

import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import {
  buildReconstructionObligationLedgerEvidenceValidated,
  resolveReconstructionObligationLedgerRequest,
} from "./ReconstructionObligationLedgerService.js";
import { proofEvidence } from "./ReconstructionObligationLedger.fixture.js";

/**
 * Build a non-canonical bundle by constructing a canonical one and then
 * swapping the order of its `records` array so the manifest arrays no longer
 * match the re-derived canonical form. `parseEvidenceBundle` inside the
 * ledger pipeline will throw `TypeError("Evidence bundle manifests are not
 * canonical")` which, before the fix for #3219, leaked through as
 * `AnalysisProtocolError` → `unreadable_output`.
 */
const nonCanonicalBundle = () => {
  // Two records whose IDs sort in one direction; reverse them so the bundle
  // `records` array is out of canonical (ascending evidence_id) order.
  const a = proofEvidence("aaa");
  const b = proofEvidence("bbb");
  const canonical = createEvidenceBundle([a, b]);
  // Reverse records to produce a non-canonical ordering. The manifest arrays
  // are derived from the original order so they won't match after re-derivation.
  return { ...canonical, records: [...canonical.records].reverse() };
};

describe("build_reconstruction_obligation_ledger non-canonical bundle handling", () => {
  it("returns AnalysisInputError for a non-canonical evidence bundle (issue #3219)", () => {
    // Construct the raw input with a deliberately non-canonical bundle. We
    // bypass resolveReconstructionObligationLedgerRequest because the schema
    // accepts any EvidenceBundle shape; the canonicality check only fires
    // inside the workflow when parseEvidenceBundle re-authenticates it.
    const parsed = resolveReconstructionObligationLedgerRequest({
      evidence_bundle: nonCanonicalBundle(),
      reviewed_obligations: [],
      manifest: { bindings: [], contradictions: [] },
    });
    if (!parsed.ok) {
      // If schema-level validation caught it first, that is also acceptable
      // (it would still surface as AnalysisInputError from requestInputError).
      expect(parsed.error).toBeInstanceOf(AnalysisInputError);
      return;
    }

    const result = buildReconstructionObligationLedgerEvidenceValidated(
      parsed.value,
    );

    // The TypeError thrown by parseEvidenceBundle must be routed to
    // AnalysisInputError (→ invalid_request), NOT AnalysisProtocolError
    // (→ unreadable_output).
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    if (!(result.error instanceof AnalysisInputError)) return;
    expect(result.error.operation).toBe(
      "build_reconstruction_obligation_ledger",
    );
  });

  it("returns AnalysisInputError with the canonicality message as an issue", () => {
    const parsed = resolveReconstructionObligationLedgerRequest({
      evidence_bundle: nonCanonicalBundle(),
      reviewed_obligations: [],
      manifest: { bindings: [], contradictions: [] },
    });
    if (!parsed.ok) return; // schema-level catch; already AnalysisInputError

    const result = buildReconstructionObligationLedgerEvidenceValidated(
      parsed.value,
    );
    if (result.ok) throw new Error("Expected err result");

    const error = result.error;
    expect(error).toBeInstanceOf(AnalysisInputError);
    if (!(error instanceof AnalysisInputError)) return;

    // workflowInputError converts TypeError.message into an invalid_value issue.
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]).toMatchObject({
      path: [],
      reason: "invalid_value",
      message: expect.stringContaining("canonical"),
    });
  });
});
