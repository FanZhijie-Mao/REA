import {
  Client,
  InMemoryTransport,
  ProtocolError,
  SdkError,
} from "@modelcontextprotocol/client";
import type { Logger } from "pino";
import { createBinarySession } from "./binary.js";
import { createServer } from "../server/createServer.js";
import {
  createOptionalObservationFactories,
  loadOptionalObservationProviders,
} from "./optionalObservationProviders.js";
import { parseConfig } from "../config/parseConfig.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import type {
  BatchCall,
  BatchOptions,
  BatchRecord,
} from "../domain/batchCalls.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { jsonValueSchema } from "../domain/jsonValue.js";

/** One production registry and provider session, with no stdio child or network listener. */
export const runBatchSession = async (input: {
  readonly calls: readonly BatchCall[];
  readonly options: BatchOptions;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly emit: (record: BatchRecord) => Promise<void>;
}): Promise<{ readonly failed: boolean }> => {
  const {
    calls,
    options,
    environment: selectedEnvironment,
    logger,
    signal,
    emit,
  } = input;
  const environment = snapshotEnvironment({
    ...selectedEnvironment,
    ...(options.provider === undefined
      ? {}
      : { REA_ANALYSIS_PROVIDER: options.provider }),
  });
  const config = parseConfig(environment);
  if (!config.ok) throw config.error;
  if (signal.aborted) throw new AnalysisCancelledError("batch");
  const session = createBinarySession(config.value, logger, environment);
  const client = new Client({ name: "rea-cli-batch", version: "1" });
  let server: ReturnType<typeof createServer> | undefined;
  let optional:
    | Awaited<ReturnType<typeof loadOptionalObservationProviders>>
    | undefined;
  let failed = false;
  let failure: { readonly cause: unknown } | undefined;
  try {
    optional = await loadOptionalObservationProviders(
      createOptionalObservationFactories(environment),
    );
    server = createServer(
      { kind: "session", session },
      { environment, logger, ...optional },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const call of calls) {
      if (signal.aborted) throw new AnalysisCancelledError("batch");
      const record = await callBatchTool({
        client,
        call,
        signal,
        timeout:
          options.timeoutMs ??
          Math.max(
            config.value.ghidraStartupTimeoutMs,
            config.value.hopperStartupTimeoutMs,
          ),
      });
      await emit(record);
      if (record.status === "error") {
        failed = true;
        if (!options.continue || signal.aborted) break;
      }
    }
    if (options.snapshot !== undefined && !signal.aborted) {
      const saved = await session.closeWithSnapshot(options.snapshot, false);
      if (!saved.ok) throw saved.error;
    }
  } catch (cause: unknown) {
    failure = { cause };
  }
  const cleanup = await closeBatchResources({
    client,
    session,
    server,
    optional,
  });
  if (cleanup !== undefined) {
    const primary =
      failure?.cause instanceof AnalysisError
        ? failure.cause
        : failure === undefined
          ? undefined
          : new ProviderAdapterError("rea-batch", "batch", { cause: failure });
    throw primary === undefined
      ? cleanup
      : analysisErrorWithCleanupFailure(primary, cleanup, "batch");
  }
  if (failure !== undefined) throw failure.cause;
  return { failed };
};

const closeBatchResources = async (input: {
  readonly client: Client;
  readonly session: ReturnType<typeof createBinarySession>;
  readonly server: ReturnType<typeof createServer> | undefined;
  readonly optional:
    | Awaited<ReturnType<typeof loadOptionalObservationProviders>>
    | undefined;
}): Promise<ProviderCleanupError | undefined> => {
  const { client, session, server, optional } = input;
  // Session.close waits for admitted native operations to settle. Every resource
  // remains owned through its cleanup attempt, including failed optional peers.
  const results = await Promise.allSettled([
    client.close(),
    session.close().then((closed) => {
      if (!closed.ok) throw closed.error;
    }),
    server?.close(),
    optional?.browserScenarioCapture?.close?.(),
  ]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  return errors.length === 0
    ? undefined
    : new ProviderCleanupError(
        "rea-batch",
        [],
        { reason: "One or more batch session resources could not be closed." },
        {
          operation: "batch",
          cause: new AggregateError(errors, "Batch cleanup failed"),
        },
      );
};

const callBatchTool = async (input: {
  readonly client: Client;
  readonly call: BatchCall;
  readonly signal: AbortSignal;
  readonly timeout: number;
}): Promise<BatchRecord> => {
  const { client, call, signal, timeout } = input;
  const started = performance.now();
  try {
    const result = await client.callTool(
      { name: call.tool, arguments: call.arguments },
      {
        signal,
        timeout,
      },
    );
    return {
      id: call.id,
      tool: call.tool,
      status: result.isError === true ? "error" : "ok",
      duration_ms: performance.now() - started,
      // MCP serializes the structured success in its text content too. Deliver
      // the canonical value once; preserve content-only results and errors intact.
      result: jsonValueSchema.parse(
        result.isError === true || result.structuredContent === undefined
          ? result
          : result.structuredContent,
      ),
      ...(result._meta === undefined
        ? {}
        : { _meta: jsonValueSchema.parse(result._meta) }),
    };
  } catch (cause: unknown) {
    const error = signal.aborted
      ? projectAnalysisError(new AnalysisCancelledError(call.tool))
      : cause instanceof ProtocolError || cause instanceof SdkError
        ? {
            code: cause.code,
            message: cause.message,
            ...(cause.data === undefined
              ? {}
              : { data: jsonValueSchema.parse(cause.data) }),
          }
        : projectAnalysisError(
            cause instanceof AnalysisError
              ? cause
              : new ProviderAdapterError("rea-batch", call.tool, { cause }),
          );
    return {
      id: call.id,
      tool: call.tool,
      status: "error",
      duration_ms: performance.now() - started,
      error: jsonValueSchema.parse(error),
    };
  }
};
