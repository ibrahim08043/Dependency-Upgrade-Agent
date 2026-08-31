import type { JsonSchema } from "../../services/ai/types";

export const stringParam = (description: string): JsonSchema => ({
  type: "string",
  description,
});

export const stringPath = (description = "Relative path inside the workspace."): JsonSchema =>
  stringParam(description);

export const integerParam = (description: string, minimum?: number): JsonSchema => ({
  type: "integer",
  description,
  ...(minimum !== undefined ? { minimum } : {}),
});

// Type utilities to keep ToolSchema types honest.
export type ToolInput = Record<string, unknown>;

export type OwnParams<Params> = {
  [K in keyof Params]: Params[K];
};