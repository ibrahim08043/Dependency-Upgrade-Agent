import type { ChatMessage, GrokCompletionResponse, GrokProvider, ToolDefinition } from "../src/services/ai/types";

/**
 * Scripted provider for testing the self-healing failure diagnosis. Mocks ONLY
 * the xAI API boundary; the diagnosis parsing in src/lib/heal.ts runs for real.
 */
export class ScriptedDiagnosisProvider implements GrokProvider {
  calls = 0;
  constructor(
    private readonly config: { valid: boolean; summary: string },
  ) {}
  isConfigured(): boolean {
    return true;
  }
  async chat(messages: ChatMessage[], _tools?: ToolDefinition[]): Promise<GrokCompletionResponse> {
    this.calls += 1;
    void messages;
    const summary = this.config.valid
      ? JSON.stringify({ summary: this.config.summary })
      : this.config.summary;
    return { summary, toolCalls: [] };
  }
}
