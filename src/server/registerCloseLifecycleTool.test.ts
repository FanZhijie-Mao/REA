import { describe, expect, it, vi } from "vitest";

import { toolContract } from "../contracts/toolContracts.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { err, ok } from "../domain/result.js";
import type { LifecycleToolRegistration } from "./registerSessionTools.js";
import { registerCloseLifecycleTool } from "./registerCloseLifecycleTool.js";

type Handler = (
  input: Record<string, unknown>,
  context: unknown,
) => Promise<unknown>;

const register = (overrides: {
  readonly closeSession: () => Promise<unknown>;
  readonly retry: () => Promise<unknown>;
}): { readonly handler: () => Promise<unknown> } => {
  let handler: Handler | undefined;
  const registration = {
    server: {
      registerTool: (_name: string, _options: unknown, callback: Handler) => {
        handler = callback;
      },
      delivery: { toCallToolResult: (result: unknown) => result },
    },
    session: { close: overrides.closeSession },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    closeContract: toolContract("close_binary"),
    closeProcessResources: async () => ok(null),
    retryReverseEngineeringCleanup: overrides.retry,
  } as unknown as LifecycleToolRegistration;
  registerCloseLifecycleTool(registration);
  return {
    handler: () =>
      handler!(
        {},
        { mcpReq: { _meta: undefined, notify: async () => undefined } },
      ),
  };
};

describe("close lifecycle reverse cleanup ordering", () => {
  it("retries reverse cleanup only after the session close has settled", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { handler } = register({
      closeSession: async () => {
        order.push("close-start");
        await gate;
        order.push("close-end");
        return ok({ closed: true });
      },
      retry: async () => {
        order.push("retry");
        return ok(null);
      },
    });

    const running = handler();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["close-start"]);
    release();
    await running;

    expect(order).toEqual(["close-start", "close-end", "retry"]);
  });

  it("keeps reverse cleanup failure primary when the session close also fails", async () => {
    const reverse = new AnalysisOutputError("rizin", "descendant still live", {
      cleanup: { reason: "still live", resources: ["rizin-owner"] },
    });
    const { handler } = register({
      closeSession: async () =>
        err(new AnalysisOutputError("close_binary", "snapshot write failed")),
      retry: async () => err(reverse),
    });

    const result = (await handler()) as {
      ok: boolean;
      error: AnalysisOutputError;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toBe(reverse);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.diagnostics).toHaveProperty("close_error");
  });
});
