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

/** The OpenAI-compatible shape of a tool call emitted on an assistant message. */
export interface AssistantToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** tool call id that produced this message (role === "tool"). */
  tool_call_id?: string;
  /**
   * OpenAPI-compatible tool_calls array carried on an `assistant` message that
   * precedes `tool` result messages. The OpenAI spec (enforced by strict
   * providers such as Groq's Harmony templater) requires every `tool` message to
   * follow an `assistant` message that DECLARES the matching tool call — without
   * this, tool results have no declared call to bind to and the request fails.
   */
  tool_calls?: AssistantToolCall[];
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
  /** Resolved model name (e.g. "grok-4-latest"). Used for non-sensitive metadata. */
  readonly model: string;
}

export class GrokConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrokConfigError";
  }
}

/**
 * Best-effort sanity check on a configured xAI key so a copy/paste error (e.g. a
 * Groq `gsk_` key or an Anthropic `sk-ant` key) fails fast with a clear message
 * instead of surfacing as a confusing 400 from the xAI API on every call.
 *
 * We deliberately do NOT reject every key that lacks an `xai-` prefix (future
 * key formats) — only keys that are clearly empty, too short, or carry another
 * provider's well-known prefix.
 */
export function invalidXaiKeyReason(key: string): string | null {
  if (!key) return "XAI_API_KEY is not set.";
  if (key.length < 20) {
    return "XAI_API_KEY looks too short to be a valid key.";
  }
  if (/^(sk-ant|sk-proj|sk-svcacct)/.test(key)) {
    return "XAI_API_KEY does not look like an xAI or Grok key (it carries another provider's prefix).";
  }
  // gsk_ prefix is accepted — it's a Groq-format key used with the Groq API.
  return null;
}

export class GrokApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrokApiError";
  }
}