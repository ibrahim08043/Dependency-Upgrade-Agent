import type { ChatMessage, GrokCompletionResponse, GrokProvider, ToolDefinition } from "../src/services/ai/types";

/**
 * Scripted provider for testing Grok research synthesis. It mocks ONLY the xAI
 * API boundary (returns a structured JSON summary). The synthesis parsing and
 * prompt-construction logic in src/lib/synthesis.ts run for real.
 */
export class ScriptedSynthesisProvider implements GrokProvider {
  calls = 0;
  isConfigured(): boolean {
    return true;
  }

  /** Scripted test provider — fixed model name for AI-stage metadata. */
  readonly model = "scripted-test-model";
  async chat(messages: ChatMessage[], _tools?: ToolDefinition[]): Promise<GrokCompletionResponse> {
    this.calls += 1;
    // Respond based on what the prompt asked for.
    const last = messages[messages.length - 1]?.content ?? "";
    const hasFindings = last.includes("removed_apis");
    const summary = hasFindings
      ? JSON.stringify({
          confidence: "high",
          breaking_changes: ["oldAPI removed in v2"],
          removed_apis: ["oldAPI"],
          renamed_apis: [],
          changed_apis: [],
          configuration_changes: [],
          import_changes: [],
          compatibility_requirements: [],
          upgrade_notes: ["Migrate off oldAPI before upgrading."],
          findings: [
            {
              category: "removed_api",
              title: "oldAPI removed",
              description: "The oldAPI function was removed in v2.",
              sourceUrl: "https://example.com/guide",
              evidence: "oldAPI removed",
              confident: true,
            },
          ],
        })
      : JSON.stringify({ confidence: "none", breaking_changes: [], removed_apis: [], renamed_apis: [], changed_apis: [], configuration_changes: [], import_changes: [], compatibility_requirements: [], upgrade_notes: [], findings: [] });
    return { summary, toolCalls: [] };
  }
}
