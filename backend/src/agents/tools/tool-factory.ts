import type { JsonSchema } from "../../services/ai/types";
import type { ToolContext } from "./context";
import type { AgentTool, ToolResult } from "./types";
import { ToolError } from "./path";

// Params may be any object; we loosen the constraint so tool interfaces don't
// need an index signature. Inputs are cast on entry.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ParamsOf = Record<string, any>;

export interface AgentToolOptions<Params = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JsonSchema;
  run(input: Params, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Standardized tool factory: every failure is boxed into the structured
 * `{ ok: false, errorType, message, path }` shape so the agent can recover.
 * ToolError carries a machine-readable errorType.
 */
export function createTool<Params extends object = Record<string, unknown>>(
  options: AgentToolOptions<Params>,
): AgentTool {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    async run(input, ctx) {
      try {
        return await options.run(input as unknown as Params, ctx);
      } catch (error) {
        if (error instanceof ToolError) {
          return { ok: false, errorType: error.errorType, message: error.message, path: error.path };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, errorType: "TOOL_ERROR", message };
      }
    },
    toDefinition() {
      return { name: this.name, description: this.description, parameters: this.parameters };
    },
  };
}

export type { AgentTool };

// Re-export for convenience.
export { ToolError } from "./path";