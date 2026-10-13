import { z } from "zod";
import type { AnalysisProviderSelector } from "../contracts/providerSelection.js";
import { jsonObjectSchema, type JsonValue } from "./jsonValue.js";

/** Ordered caller-selected tool requests; arguments retain the canonical MCP representation. */
export const batchCallsSchema = z.array(
  z.strictObject({
    id: z.union([z.string().min(1), z.number().int().safe()]),
    tool: z.string().min(1),
    arguments: jsonObjectSchema,
  }),
);
export type BatchCall = z.infer<typeof batchCallsSchema>[number];
export interface BatchOptions {
  readonly target?: string | undefined;
  readonly provider?: AnalysisProviderSelector | undefined;
  readonly out?: string | undefined;
  readonly snapshot?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly continue: boolean;
}
export interface BatchRecord {
  readonly id: string | number;
  readonly tool: string;
  readonly status: "ok" | "error";
  readonly duration_ms: number;
  readonly result?: JsonValue;
  readonly error?: JsonValue;
  readonly _meta?: JsonValue;
}
