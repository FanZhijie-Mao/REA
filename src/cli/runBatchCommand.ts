import { constants } from "node:buffer";
import { mkdir, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { addAbortListener } from "node:events";
import { getHeapStatistics } from "node:v8";
import type { Logger } from "pino";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { readJsonFile, writeTextParts } from "../application/JsonFiles.js";
import { parseUtf8Json } from "../application/Utf8JsonInput.js";
import {
  batchCallsSchema,
  type BatchCall,
  type BatchOptions,
} from "../domain/batchCalls.js";
import { jsonParts } from "../domain/jsonSerialization.js";
import {
  AnalysisInputError,
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { EvidenceFileError } from "../domain/evidenceErrors.js";
import { writeJsonOutput } from "./jsonOutput.js";

/** Validate all structural inputs and output collisions before acquiring a provider. */
export const runBatchCommand = async (input: {
  readonly path: string;
  readonly options: BatchOptions;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly logger: Logger;
  readonly signal: AbortSignal;
}): Promise<{ readonly failed: boolean }> => {
  const { path, options, environment, logger, signal } = input;
  const resources = new ArtifactResourceScope();
  try {
    const value =
      path === "-"
        ? await readStdin(signal)
        : await readJsonFile(path, signal, resources);
    if (!value.ok) throw value.error;
    const parsed = batchCallsSchema.safeParse(value.value);
    if (!parsed.success)
      throw new AnalysisInputError(
        "batch",
        undefined,
        projectInputIssues(parsed.error.issues, value.value),
      );
    const calls: BatchCall[] = [
      ...(options.target === undefined
        ? []
        : [
            {
              id: "batch-open",
              tool: "open_binary",
              arguments: {
                path: resolve(options.target),
                ...(options.provider === undefined
                  ? {}
                  : { provider_id: options.provider }),
              },
            },
          ]),
      ...parsed.data,
    ];
    const directory =
      options.out === undefined ? undefined : resolve(options.out);
    await preflightOutput(calls, directory);
    if (directory !== undefined) await mkdir(directory, { recursive: true });
    const { runBatchSession } = await import("../composition/batchSession.js");
    const outcome = await runBatchSession({
      calls,
      options: {
        ...options,
        ...(options.snapshot === undefined
          ? {}
          : { snapshot: resolve(options.snapshot) }),
      },
      environment,
      logger,
      signal,
      emit: async (record) => {
        if (directory === undefined)
          await writeJsonOutput(record, process.stdout, "jsonl");
        else {
          const written = await writeTextParts(
            jsonParts(record),
            join(directory, `${String(record.id)}.json`),
            false,
            resources,
            { signal, operation: "batch" },
          );
          if (!written.ok) throw written.error;
        }
      },
    });
    return outcome;
  } finally {
    await resources.close();
  }
};

const readStdin = async (signal: AbortSignal) => {
  const chunks: Buffer[] = [];
  let size = 0;
  // Bound the retained bytes and decoding copies by the runtime's available heap.
  const maximum = Math.min(
    constants.MAX_LENGTH,
    Math.floor(getHeapStatistics().total_available_size / 4),
  );
  const cancellation = addAbortListener(signal, () =>
    process.stdin.destroy(new AnalysisCancelledError("batch")),
  );
  try {
    if (signal.aborted) throw new AnalysisCancelledError("batch");
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as string);
      size += bytes.length;
      if (size > maximum)
        throw new AnalysisResourceConstraintError(
          "batch",
          "memory",
          "Stdin input exceeds the available retained-input budget",
          { input_bytes_at_least: size, max_input_bytes: maximum },
        );
      chunks.push(bytes);
    }
    const parsed = parseUtf8Json(Buffer.concat(chunks, size), "batch", "stdin");
    if (!parsed.ok)
      throw parsed.cause instanceof AnalysisResourceConstraintError
        ? parsed.cause
        : new AnalysisInputError("batch", {
            userMessage: "Batch stdin must contain one valid UTF-8 JSON array.",
          });
    return { ok: true as const, value: parsed.value };
  } finally {
    cancellation[Symbol.dispose]();
  }
};

const preflightOutput = async (
  calls: readonly BatchCall[],
  directory: string | undefined,
): Promise<void> => {
  const seen = new Set<string | number>();
  const filenames = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.id))
      throw new AnalysisInputError("batch", {
        userMessage:
          "Batch call IDs must be unique, including batch-open when --target is used.",
      });
    seen.add(call.id);
    if (directory !== undefined) {
      const id = String(call.id);
      if (
        !/^[A-Za-z0-9_.-]+$/u.test(id) ||
        id.endsWith(".") ||
        id.length + ".json".length > 255 ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(id) ||
        filenames.has(id.toLowerCase())
      )
        throw new AnalysisInputError("batch", {
          userMessage:
            "File-output IDs must be unique portable basenames, including on case-insensitive filesystems.",
        });
      filenames.add(id.toLowerCase());
      try {
        await access(join(directory, `${id}.json`));
        throw new EvidenceFileError("write", "exists", {
          path: join(directory, `${id}.json`),
        });
      } catch (cause: unknown) {
        if (
          !(
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "ENOENT"
          )
        )
          throw cause;
      }
    }
  }
};
