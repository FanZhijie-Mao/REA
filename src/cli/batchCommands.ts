import { z } from "incur";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { analysisProviderSelectorSchema } from "../contracts/providerSelection.js";
import { logCliCommand } from "../cliLogging.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { writeJsonOutput } from "./jsonOutput.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";

/** Register a lazy adapter: ordinary CLI commands do not load the MCP registry. */
export const registerBatchCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  cli.command(CLI_COMMANDS.batch, {
    description:
      "Run ordered MCP tool calls in one session; stream JSONL results",
    args: z.object({
      calls: z.string().describe("JSON call-list file, or - for stdin"),
    }),
    options: z.object({
      target: z
        .string()
        .optional()
        .describe("Open this local target before the call list"),
      provider: analysisProviderSelectorSchema.optional(),
      out: z
        .string()
        .optional()
        .describe("Directory for exclusively created <id>.json results"),
      jsonl: z
        .boolean()
        .default(false)
        .describe("Explicitly select the default JSONL output"),
      continue: z
        .boolean()
        .default(false)
        .describe("Continue after errors; still exit with failure"),
      stopOnError: z
        .boolean()
        .default(false)
        .describe("Stop on first error (default)"),
      snapshot: z
        .string()
        .optional()
        .describe("Save an analysis snapshot before closing"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .safe()
        .max(2_147_483_647)
        .optional()
        .describe("Per-call MCP timeout in milliseconds"),
    }),
    mcp: false,
    run: async (context) => {
      const outcome = await withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.batch,
          async () => {
            if (
              (context.options.continue && context.options.stopOnError) ||
              (context.options.jsonl && context.options.out !== undefined) ||
              (context.formatExplicit && context.format !== "jsonl")
            )
              throw new AnalysisInputError("batch", {
                userMessage:
                  "Choose one error policy and one batch destination. Batch stdout uses JSONL; only --format jsonl is supported.",
              });
            const { runBatchCommand } = await import("./runBatchCommand.js");
            return runBatchCommand({
              path: context.args.calls,
              options: context.options,
              environment,
              logger,
              signal,
            });
          },
          (result) => result.failed,
        ),
      );
      if ("code" in outcome)
        await writeJsonOutput(
          { id: null, tool: "batch", status: "error", error: outcome },
          process.stdout,
          "jsonl",
        );
      // Batch owns its streamed output. Do not append Incur's empty result document.
      return context.ok(undefined);
    },
  });
};
