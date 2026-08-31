import type { JsonSchema, ToolDefinition } from "../../services/ai/types";
import type { ToolContext } from "./context";

export type ToolResult =
  | { ok: true; result: unknown }
  | { ok: false; errorType: string; message: string; path?: string };

export interface AgentTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  toDefinition(): ToolDefinition;
}