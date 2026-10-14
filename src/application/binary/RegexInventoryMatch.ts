import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../../domain/result.js";

export const REGEX_MATCHING_DEADLINE_MS = 5_000;

const replySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("matched"),
    indices: z.array(z.number().int().nonnegative()),
  }),
  z.strictObject({ status: z.literal("invalid_pattern"), reason: z.string() }),
]);

// Self-contained so the worker runs from source and from the built package alike.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
let expression;
try {
  expression = new RegExp(workerData.pattern, workerData.caseSensitive ? "u" : "iu");
} catch (cause) {
  parentPort.postMessage({ status: "invalid_pattern", reason: cause instanceof Error ? cause.message : String(cause) });
}
if (expression !== undefined) {
  const indices = [];
  for (let index = 0; index < workerData.values.length; index += 1)
    if (expression.test(workerData.values[index])) indices.push(index);
  parentPort.postMessage({ status: "matched", indices });
}
`;

export interface RegexInventoryMatchRequest {
  readonly operation: string;
  readonly values: readonly string[];
  readonly pattern: string;
  readonly caseSensitive: boolean;
  readonly signal?: AbortSignal | undefined;
  readonly deadlineMs?: number;
  /** Error for a pattern the ECMAScript engine rejects; providers map it to their input-error shape. */
  readonly invalidPattern: (reason: string) => AnalysisError;
  /** Remediation shown when matching exceeds the deadline. */
  readonly deadlineRemediation: string;
}

/**
 * Match an inventory against a caller-supplied ECMAScript Unicode regex off the
 * event loop, with a cancellable lifetime and a supervised deadline, so a
 * pathological pattern cannot stall the provider session.
 */
export const matchInventoryByRegex = async (
  request: RegexInventoryMatchRequest,
): Promise<Result<readonly number[], AnalysisError>> => {
  const { operation, signal } = request;
  const deadlineMs = request.deadlineMs ?? REGEX_MATCHING_DEADLINE_MS;
  if (signal?.aborted) return err(new AnalysisCancelledError(operation));
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        pattern: request.pattern,
        caseSensitive: request.caseSensitive,
        values: [...request.values],
      },
    });
  } catch (cause: unknown) {
    return err(
      new AnalysisOutputError(
        operation,
        `Cannot start regex worker: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      ),
    );
  }
  try {
    return await new Promise<Result<readonly number[], AnalysisError>>(
      (resolve) => {
        const finish = (result: Result<readonly number[], AnalysisError>) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        };
        const onAbort = (): void =>
          finish(err(new AnalysisCancelledError(operation)));
        const timer = setTimeout(
          () =>
            finish(
              err(
                new AnalysisResourceConstraintError(
                  operation,
                  "cpu",
                  "Regex matching exceeded its supervised deadline; the provider session remains available.",
                  { matching_deadline_ms: deadlineMs },
                  { remediationAction: request.deadlineRemediation },
                ),
              ),
            ),
          deadlineMs,
        );
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        worker.once("message", (message: unknown) => {
          const reply = replySchema.safeParse(message);
          if (!reply.success)
            return finish(
              err(
                new AnalysisOutputError(
                  operation,
                  "Regex worker reply is malformed",
                ),
              ),
            );
          if (reply.data.status === "invalid_pattern")
            return finish(err(request.invalidPattern(reply.data.reason)));
          const indices = reply.data.indices;
          if (
            indices.some(
              (index, position) =>
                index >= request.values.length ||
                (position > 0 && index <= (indices[position - 1] ?? -1)),
            )
          )
            return finish(
              err(
                new AnalysisOutputError(
                  operation,
                  "Regex worker returned invalid inventory indices",
                ),
              ),
            );
          finish(ok(indices));
        });
        worker.once("error", (cause: Error) =>
          finish(
            err(
              new AnalysisOutputError(
                operation,
                `Regex worker failed: ${cause.message}`,
                { cause },
              ),
            ),
          ),
        );
        worker.once("exit", (code) =>
          finish(
            err(
              new AnalysisOutputError(
                operation,
                `Regex worker exited without a result (${code})`,
              ),
            ),
          ),
        );
      },
    );
  } finally {
    await worker.terminate();
  }
};
