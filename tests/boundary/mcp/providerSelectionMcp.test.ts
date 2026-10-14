import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  createAnalysisExecution,
  type AnalysisOperation,
  type AnalysisProviderCandidate,
  type CapabilityDescriptor,
  type ProviderIdentity,
} from "../../../src/application/AnalysisProvider.js";
import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import {
  expandToolAvailability,
  toolAvailabilityInventory,
} from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { ok } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";

const resources: Array<{ close(): Promise<unknown> }> = [];
let directory: string | undefined;

type DeclaredOperation = Exclude<AnalysisOperation, "health">;

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/** Connected MCP session over two configured deep providers for one target. */
const selectionHarness = async () => {
  directory = await createTestTempDirectory("rea-provider-mcp-");
  const target = join(directory, "fixture.hop");
  await writeFile(target, "fixture");
  const starts: string[] = [];
  const session = composeBinarySession(
    new AnalysisProviderRegistry([
      // Overlapping but different capability sets, so per-operation advice can be
      // distinguished from session-level eligibility.
      candidate("beta", starts, ["address_name"]),
      candidate("alpha", starts, ["address_name", "analyze_function"]),
    ]),
  );
  const server = createServer(
    { kind: "session", session },
    { logger: silentLogger },
  );
  const mcp = new Client({ name: "provider-selection", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(mcp, server);
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return { mcp, target, starts };
};

describe("provider selection over MCP", () => {
  it("reports target-free discovery and rejects a malformed selector", async () => {
    const { mcp, target, starts } = await selectionHarness();

    const before = structured(
      await mcp.callTool({ name: "binary_session", arguments: {} }),
    );
    expect(before.result).toMatchObject({
      open: false,
      analysis_provider_selection_state: null,
      analysis_run: null,
      analysis_provider_binding: null,
      analysis_provider_candidates: [
        {
          provider: { id: "alpha" },
          target_support: { status: "unknown" },
          eligibility: "unevaluated",
          selected: false,
        },
        {
          provider: { id: "beta" },
          target_support: { status: "unknown" },
          eligibility: "unevaluated",
          selected: false,
        },
      ],
    });
    expect(starts).toEqual([]);

    const malformed = await mcp.callTool({
      name: "open_binary",
      arguments: { path: target, provider_id: "Beta" },
    });
    expect(malformed.isError).toBe(true);
    expect(starts).toEqual([]);
  });

  it("admits a multi-candidate target in the selection-required state", async () => {
    const { mcp, target, starts } = await selectionHarness();

    // Two eligible providers: automatic selection admits the target without
    // binding or starting an engine, and reports that a decision is required.
    const undecided = await mcp.callTool({
      name: "open_binary",
      arguments: { path: target },
    });
    expect(undecided.isError).not.toBe(true);
    expect(structured(undecided).result).toMatchObject({
      path: target,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(starts).toEqual([]);

    const pending = structured(
      await mcp.callTool({ name: "binary_session", arguments: {} }),
    );
    expect(pending.result).toMatchObject({
      open: true,
      analysis_provider_selection_state: "selection_required",
      analysis_provider_binding: null,
      // Eligibility resolved each profile to version "1", so the reported
      // candidates and their capabilities must carry that concrete identity even
      // though no provider is bound yet.
      analysis_provider_candidates: [
        {
          provider: { id: "alpha", version: "1" },
          eligibility: "eligible",
          selected: false,
          capabilities: [{ provider: { id: "alpha", version: "1" } }],
        },
        {
          provider: { id: "beta", version: "1" },
          eligibility: "eligible",
          selected: false,
          capabilities: [{ provider: { id: "beta", version: "1" } }],
        },
      ],
    });
    expect(starts).toEqual([]);

    // A deep operation before the caller decides stays typed and actionable.
    const premature = await mcp.callTool({
      name: "address_name",
      arguments: {},
    });
    expect(premature.isError).toBe(true);
    expect(structured(premature)).toMatchObject({
      error: {
        details: {
          selection_reason: "ambiguous",
          requested_provider_id: "auto",
          candidate_ids: ["alpha", "beta"],
        },
      },
    });
    expect(starts).toEqual([]);
  });

  it("advertises a pending provider choice instead of a missing provider", async () => {
    const { mcp, target, starts } = await selectionHarness();
    expect(
      (await mcp.callTool({ name: "open_binary", arguments: { path: target } }))
        .isError,
    ).not.toBe(true);

    const pending = structured(
      await mcp.callTool({ name: "binary_session", arguments: {} }),
    );
    // Discovery must not send the caller to install a provider that is already
    // installed: an unavailable deep operation names the pending choice and the
    // eligible candidates instead of a missing provider.
    const inventory = toolAvailabilityInventory.parse(
      z
        .object({
          result: z.object({ tool_availability: z.unknown() }),
        })
        .passthrough()
        .parse(pending).result.tool_availability,
    );
    const availability = new Map(
      expandToolAvailability(inventory).map((entry) => [entry.name, entry]),
    );
    // Both eligible providers declare this operation, so both are offered.
    expect(availability.get("address_name")).toMatchObject({
      available: false,
      reason: "provider_selection_required",
      remediation:
        "Reopen the target with open_binary and provider_id set to one of: alpha, beta.",
    });
    // Advice must be resolvable: beta cannot run `analyze_function`, so it is not
    // offered for it even though it is eligible for the target.
    expect(availability.get("analyze_function")).toMatchObject({
      available: false,
      reason: "provider_selection_required",
      remediation:
        "Reopen the target with open_binary and provider_id set to one of: alpha.",
    });
    for (const name of ["binary_overview", "batch_decompile"]) {
      // No eligible provider declares what these need, so the pending choice is
      // not the blocker and the missing capability is reported instead.
      expect(availability.get(name)).toMatchObject({
        available: false,
        reason: "provider_missing",
      });
    }
    // Admission itself stays available, and auxiliary capabilities are untouched.
    expect(availability.get("open_binary")).toMatchObject({
      available: true,
    });
    expect(availability.get("inspect_artifact")).toMatchObject({
      available: true,
    });
    expect(starts).toEqual([]);
  });
});

describe("explicit provider selection over MCP", () => {
  it("binds an explicitly selected provider and keeps it stable", async () => {
    const { mcp, target, starts } = await selectionHarness();

    const opened = await mcp.callTool({
      name: "open_binary",
      arguments: { path: target, provider_id: "beta" },
    });
    expect(opened.isError).not.toBe(true);
    expect(starts).toEqual([]);

    const observed = await mcp.callTool({
      name: "address_name",
      arguments: {},
    });
    expect(observed.isError).not.toBe(true);
    expect(structured(observed)).toMatchObject({
      normalized_result: "beta:address_name",
      evidence_id: expect.stringMatching(/^ev_/u),
    });
    expect(starts).toEqual(["beta"]);

    const status = structured(
      await mcp.callTool({ name: "binary_session", arguments: {} }),
    );
    expect(status.result).toMatchObject({
      open: true,
      analysis_provider_selection_state: "bound",
      analysis_run: {
        run_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
        process_lineage: { status: "not_observed" },
      },
      analysis_provider_binding: {
        provider: { id: "beta", version: "1" },
        selection_source: "request",
      },
      analysis_provider_candidates: [
        {
          provider: { id: "alpha" },
          eligibility: "unevaluated",
          selected: false,
        },
        {
          provider: { id: "beta", version: "1" },
          eligibility: "eligible",
          selected: true,
        },
      ],
    });

    const unknown = await mcp.callTool({
      name: "open_binary",
      arguments: { path: target, provider_id: "missing" },
    });
    expect(unknown.isError).toBe(true);
    expect(structured(unknown)).toMatchObject({
      error: { details: { selection_reason: "unknown_provider" } },
    });
    expect(
      structured(await mcp.callTool({ name: "binary_session", arguments: {} }))
        .result,
    ).toMatchObject({
      analysis_provider_binding: { provider: { id: "beta" } },
    });
  });
});

const candidate = (
  id: string,
  starts: string[],
  operations: readonly DeclaredOperation[],
): AnalysisProviderCandidate => {
  const identity: ProviderIdentity = {
    id,
    name: `${id} provider`,
    version: null,
  };
  return {
    identity: () => identity,
    capabilities: () =>
      operations.map((operation) => capability(identity, operation)),
    inspectAvailability: () => ({
      status: "available",
      code: null,
      reason: null,
      diagnostics: { executable_path: `/opt/${id}/bin/analyze` },
    }),
    inspectTargetSupport: () => ({
      status: "supported",
      code: null,
      reason: null,
      diagnostics: {},
    }),
    resolveAnalysisProfile: () =>
      Promise.resolve(
        ok({
          profile: createAnalysisProfile(
            { id, name: identity.name, version: "1" },
            { fixture: id },
          ),
        }),
      ),
    createClient: (_target, profile) => {
      starts.push(id);
      return {
        execute: (operation) =>
          Promise.resolve(
            ok(
              createAnalysisExecution(
                `${id}:${operation}`,
                profile?.provider ?? identity,
              ),
            ),
          ),
        close: () => Promise.resolve(ok(null)),
      };
    },
  };
};

const capability = (
  provider: ProviderIdentity,
  operation: DeclaredOperation,
): CapabilityDescriptor => ({
  provider,
  operation,
  available: true,
  reason: null,
  effects: {
    mutatesArtifact: false,
    launchesProcess: true,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limitations: [],
});

const structured = (result: CallToolResult): Record<string, unknown> =>
  result.isError === true
    ? parseMcpToolError(result)
    : z.record(z.string(), z.unknown()).parse(result.structuredContent);
