import { expect, it, onTestFinished } from "vitest";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisProvider,
} from "../../../src/application/AnalysisProvider.js";
import { CompositeProvider } from "../../../src/application/binary/CompositeProvider.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { AnalysisTimeoutError } from "../../../src/domain/analysisErrorCore.js";
import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { err, ok } from "../../../src/domain/result.js";
import {
  createBinarySessionTargets,
  createReadOnlyCapability,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";

const connectComposite = async (
  closeAlpha: AnalysisClient["close"],
  closeBeta: AnalysisClient["close"],
) => {
  let cleanupAllowed = false;
  const provider = (
    id: string,
    operation: "address_name" | "comment",
    close: AnalysisClient["close"],
  ): AnalysisProvider => {
    const identity = { id, name: id, version: "1" };
    return {
      identity: () => identity,
      capabilities: () => [createReadOnlyCapability(identity, operation)],
      createClient: () => ({
        execute: async () => ok(createAnalysisExecution(id, identity)),
        close: async (options) => (cleanupAllowed ? ok(null) : close(options)),
      }),
    };
  };
  const [path] = await createBinarySessionTargets();
  const session = createTestBinarySession(
    new CompositeProvider([
      provider("alpha", "address_name", closeAlpha),
      provider("beta", "comment", closeBeta),
    ]),
  );
  const harness = await createApplicationMcpHarness({ session });
  onTestFinished(async () => {
    cleanupAllowed = true;
    await harness.close();
  });
  const { client } = harness;
  expect(
    (await client.callTool({ name: "open_binary", arguments: { path } }))
      .isError,
  ).not.toBe(true);
  for (const name of ["address_name", "comment"])
    expect(
      (await client.callTool({ name, arguments: { address: "0x1000" } }))
        .isError,
    ).not.toBe(true);
  return client;
};

it("reports every failed provider cleanup and retries the remaining owners through MCP", async () => {
  const remaining = new Set(["alpha", "beta"]);
  const close =
    (id: string): AnalysisClient["close"] =>
    async () =>
      remaining.has(id)
        ? err(
            new ProviderCleanupError(
              id,
              [`${id}-workspace`, "shared-runtime"],
              { reason: `${id} removal denied` },
            ),
          )
        : ok(null);
  const client = await connectComposite(close("alpha"), close("beta"));
  const first = await client.callTool({ name: "close_binary", arguments: {} });
  expect(first.isError).toBe(true);
  const content = first.content[0];
  if (content?.type !== "text") throw new Error("Missing cleanup diagnostic");
  expect(JSON.parse(content.text)).toMatchObject({
    error: {
      code: "cleanup_incomplete",
      details: {
        provider_id: "composite:alpha+beta",
        resources: ["alpha-workspace", "shared-runtime", "beta-workspace"],
        diagnostics: {
          failures: [
            {
              provider_id: "alpha",
              error: {
                details: { diagnostics: { reason: "alpha removal denied" } },
              },
            },
            {
              provider_id: "beta",
              error: {
                details: { diagnostics: { reason: "beta removal denied" } },
              },
            },
          ],
        },
      },
    },
  });
  remaining.delete("alpha");
  const retry = await client.callTool({ name: "close_binary", arguments: {} });
  expect(retry.isError).toBe(true);
  const retryContent = retry.content[0];
  if (retryContent?.type !== "text")
    throw new Error("Missing retry diagnostic");
  expect(JSON.parse(retryContent.text)).toMatchObject({
    error: {
      details: {
        provider_id: "beta",
        resources: ["beta-workspace", "shared-runtime"],
        diagnostics: { reason: "beta removal denied" },
      },
    },
  });
  remaining.clear();
  expect(
    (await client.callTool({ name: "close_binary", arguments: {} })).isError,
  ).not.toBe(true);
});

it("preserves typed partial facts alongside a normalized adapter rejection", async () => {
  let observation: Evidence | undefined;
  const client = await connectComposite(
    async () =>
      err(
        new AnalysisTimeoutError("close_binary", 300, {
          cleanup: {
            reason: "alpha still running",
            resources: ["alpha-process"],
          },
          capturedOutput: {
            stdout: "close-marker",
            stderr: "",
            truncated: false,
          },
          partialObservation: observation,
        }),
      ),
    async () => {
      throw new Error("unprojected adapter details");
    },
  );
  const observed = await client.callTool({
    name: "address_name",
    arguments: { address: "0x1000" },
  });
  observation = parseEvidence(observed.structuredContent);
  const result = await client.callTool({ name: "close_binary", arguments: {} });
  expect(result.isError).toBe(true);
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing cleanup diagnostic");
  expect(JSON.parse(content.text)).toMatchObject({
    error: {
      code: "cleanup_incomplete",
      details: {
        resources: ["alpha-process", "provider-client"],
        diagnostics: {
          failures: [
            {
              provider_id: "alpha",
              error: {
                category: "timeout",
                details: {
                  timeout_ms: 300,
                  cleanup_reason: "alpha still running",
                  captured_output: { stdout: "close-marker" },
                  partial_observation: observation,
                },
              },
            },
            {
              provider_id: "beta",
              error: {
                details: {
                  provider_id: "beta",
                  diagnostics: {
                    reason: "provider client close rejected unexpectedly",
                  },
                },
              },
            },
          ],
        },
      },
    },
  });
  expect(content.text).not.toContain("unprojected adapter details");
});
