import type { ChatMessage, GrokCompletionResponse, GrokProvider, ToolCallRequest, ToolDefinition } from "../src/services/ai/types";

/**
 * Scripted provider that reproduces a REAL self-healing scenario in tests.
 *
 *  - Initial agent pass: decides no code changes are needed (returns a final
 *    JSON summary with no tool calls). The fixture's build genuinely fails.
 *  - Diagnosis call: returns a concise JSON diagnosis referencing the type error.
 *  - Repair pass (failureContext present): drives a real `apply_patch` that fixes
 *    the failing line, so the next verification PASSes.
 *
 * This mocks ONLY the xAI API boundary; every tool call still runs through the
 * real backend tool implementations against the real filesystem.
 */
export class ScriptedHealProvider implements GrokProvider {
  calls = 0;
  repaired = false;

  constructor(private readonly fixPatch: string, private readonly fileToFix = "src/server.ts") {}

  isConfigured(): boolean {
    return true;
  }

  /** Scripted test provider — fixed model name for AI-stage metadata. */
  readonly model = "scripted-test-model";

  async chat(messages: ChatMessage[], _tools?: ToolDefinition[]): Promise<GrokCompletionResponse> {
    this.calls += 1;
    const failureContext = messages.some((m) => m.role === "user" && m.content.includes("REPAIR pass"));

    // Repair pass: apply the corrective patch once, then finish.
    if (failureContext) {
      if (!this.repaired) {
        this.repaired = true;
        return {
          summary: "Applying corrective patch to fix the build.",
          toolCalls: [makeCall("repair_1", "apply_patch", { path: this.fileToFix, patch: this.fixPatch })],
        };
      }
      // After the patch, produce the final summary so the repair pass ends.
      return {
        summary: JSON.stringify({ summary: "Applied corrective patch.", no_changes_required: false }),
        toolCalls: [],
      };
    }

    // Initial agent pass: no code changes required (fixture's real build fails).
    return {
      summary: JSON.stringify({ summary: "Determined no code changes required.", no_changes_required: false }),
      toolCalls: [],
    };
  }
}

function makeCall(id: string, name: string, argumentsObj: Record<string, unknown>): ToolCallRequest {
  return { id, name, arguments: JSON.stringify(argumentsObj) };
}
