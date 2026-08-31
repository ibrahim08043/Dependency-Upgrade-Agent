/** Shared types for the xAI/Grok completion service and the coding agent. */

export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export type ToolResult =
  | { ok: true; result: unknown }
  | { ok: false; errorType: string; message: string; path?: string };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** tool call id that produced this message (role === "tool"). */
  tool_call_id?: string;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string; // raw JSON
}

export interface GrokCompletionResponse {
  summary?: string;
  toolCalls: ToolCallRequest[];
}

export interface GrokProvider {
  /**
   * Send chat messages.  If the model emits tool calls, they are returned so
   * the caller can execute them and call `chat` again with tool results.
   */
  chat(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<GrokCompletionResponse>;
  /** Whether the provider is configured (e.g. XAI_API_KEY present). */
  isConfigured(): boolean;
}

export class GrokConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrokConfigError";
  }
}

export class GrokApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrokApiError";
  }
}