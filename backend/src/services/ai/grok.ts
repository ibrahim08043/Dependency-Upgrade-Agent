import { GrokApiError, GrokConfigError, invalidXaiKeyReason } from "./types";
import type {
  ChatMessage,
  GrokCompletionResponse,
  GrokProvider,
  ToolCallRequest,
  ToolDefinition,
} from "./types";

interface XaiToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface XaiChoice {
  message?: {
    content?: string | Array<{ type?: string; text?: string }> | null;
    tool_calls?: XaiToolCall[];
  };
  finish_reason?: string;
}

/** Default model resolved from env, overridable with XAI_MODEL. */
const DEFAULT_MODEL = "grok-4-latest";
const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";

function formatContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: string }).text ?? "") : "")).join("");
  }
  return value == null ? "" : String(value);
}

/**
 * Grok provider backed by the xAI chat-completions API with native
 * function/tool calling.  Secrets are read from the PROCESS environment
 * (XAI_API_KEY) and are never passed to the model in prompts.
 */
export class XaiGrokProvider implements GrokProvider {
  private readonly apiKey: string;
  private readonly _model: string;
  private readonly _baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch) {
    // Single secret slot: XAI_API_KEY (backward compatible) or GROQ_API_KEY.
    // Both address the OpenAI-compatible chat-completions API; the key prefix
    // decides which provider's endpoint to call.
    const key = env.XAI_API_KEY || env.GROQ_API_KEY;
    if (!key) {
      throw new GrokConfigError(
        "GROK_NOT_CONFIGURED: XAI_API_KEY (or GROQ_API_KEY) is not set on the backend. Add it to the backend environment to enable the agent.",
      );
    }
    const problem = invalidXaiKeyReason(key);
    if (problem) {
      throw new GrokConfigError(
        `GROK_NOT_CONFIGURED: ${problem} Fix XAI_API_KEY/GROQ_API_KEY in the backend environment (backend/.env).`,
      );
    }
    this.apiKey = key;
    // Auto-detect provider from key prefix: gsk_ = Groq, otherwise xAI.
    const isGroq = /^gsk_/.test(key);
    this._baseUrl = isGroq ? "https://api.groq.com/openai/v1" : "https://api.x.ai/v1";
    this._model = env.XAI_MODEL || (isGroq ? GROQ_DEFAULT_MODEL : DEFAULT_MODEL);
    this.fetchImpl = fetchImpl;
  }

  isConfigured(): boolean {
    return true;
  }

  /** GrokProvider interface: the resolved model name (non-secret metadata). */
  get model(): string {
    return this._model;
  }

  async chat(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<GrokCompletionResponse> {
    const body: Record<string, unknown> = {
      model: this._model,
      temperature: 0,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.role === "tool" ? { tool_call_id: m.tool_call_id } : {}),
        // Echo the assistant's declared tool_calls back so `tool` results can be
        // bound to them (required by the OpenAI-compatible spec / Groq Harmony).
        ...(m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0
          ? { tool_calls: m.tool_calls }
          : {}),
      })),
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const response = await this.fetchImpl(`${this._baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new GrokApiError(`GROK_API_ERROR: xAI returned ${response.status} ${response.statusText} — ${errBody.slice(0, 500)}`);
    }
    let payload: { choices?: XaiChoice[] };
    try {
      payload = (await response.json()) as { choices?: XaiChoice[] };
    } catch {
      throw new GrokApiError("GROK_API_ERROR: xAI returned an unparseable response body");
    }
    const choice = payload.choices?.[0];
    const message = choice?.message;

    const toolCalls: ToolCallRequest[] = [];
    for (const call of message?.tool_calls ?? []) {
      const id = call.id || `call_${toolCalls.length + 1}`;
      const name = call.function?.name ?? "";
      const argumentsRaw = call.function?.arguments ?? "";
      if (!name) continue;
      toolCalls.push({ id, name, arguments: argumentsRaw });
    }

    return {
      summary: message?.content != null ? formatContent(message.content) : undefined,
      toolCalls,
    };
  }
}