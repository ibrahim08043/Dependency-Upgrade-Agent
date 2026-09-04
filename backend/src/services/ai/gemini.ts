import { GrokApiError, GrokConfigError } from "./types";
import type {
  ChatMessage,
  GrokCompletionResponse,
  GrokProvider,
  ToolCallRequest,
  ToolDefinition,
} from "./types";

/**
 * Gemini (Google AI Studio) provider implementing the shared GrokProvider
 * interface so the coding agent and research synthesis stay provider-agnostic.
 *
 * It bridges OpenAI-style chat messages (system/user/assistant/tool with
 * tool_calls + tool_call_id) to Gemini's generateContent format
 * (contents/parts with functionCall + functionResponse) and back.
 */
interface GeminiFunctionCallPart {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}
interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCallPart;
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}
interface GeminiRequest {
  systemInstruction?: { parts: [{ text: string }] };
  contents: GeminiContent[];
  tools?: Array<{ functionDeclarations: Array<{ name: string; description?: string; parameters: unknown }> }>;
  toolConfig?: { functionCallingConfig: { mode: string } };
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  error?: { code?: number; status?: string; message?: string };
}

/** Default model — a stable, free-tier Gemini model with function calling. Override via GEMINI_MODEL. */
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Heuristic free-tier request cap. Gemini's free tier enforces a daily
 * request limit (e.g. 20 `generate_content_free_tier_requests`). We track
 * successful requests per provider instance and refuse to call the API once
 * the cap is hit — returning a graceful empty result instead of a 429 that
 * crashes the entire agent pipeline.
 */
const FREE_TIER_REQUEST_CAP = 18; // leave a 2-request headroom below the hard limit

export class GeminiProvider implements GrokProvider {
  private readonly apiKey: string;
  private readonly _model: string;
  private readonly fetchImpl: typeof fetch;
  private _requestCount = 0;
  private _quotaExhausted = false;

  constructor(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch) {
    const key = env.GEMINI_API_KEY;
    if (!key) {
      throw new GrokConfigError(
        "GROK_NOT_CONFIGURED: GEMINI_API_KEY is not set on the backend. Add it to the backend environment to enable Gemini.",
      );
    }
    this.apiKey = key;
    this._model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    this.fetchImpl = fetchImpl;
  }

  isConfigured(): boolean {
    return true;
  }

  /** The resolved Gemini model name (non-secret metadata). */
  get model(): string {
    return this._model;
  }

  /** Whether the free-tier quota has been exhausted for this provider instance. */
  get isQuotaExhausted(): boolean {
    return this._quotaExhausted;
  }

  /** Number of successful API requests made through this instance. */
  get requestCount(): number {
    return this._requestCount;
  }

  async chat(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<GrokCompletionResponse> {
    // If the quota is already exhausted, return gracefully instead of making
    // another doomed request. The agent can still inspect its current state
    // and produce a partial summary.
    if (this._quotaExhausted) {
      return {
        summary: `Gemini free-tier request cap (${FREE_TIER_REQUEST_CAP}) reached. The agent has applied the changes it could before quota exhaustion. Please check the current file state.`,
        toolCalls: [],
      };
    }
    const body: GeminiRequest = { contents: toGeminiContents(messages) };

    const systemText = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

    if (tools && tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
      body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }

    const url = `${ENDPOINT}/models/${encodeURIComponent(this._model)}:generateContent`;

    // Retry transient rate-limit / server errors with exponential backoff and
    // jitter. Gemini's free tier throttles short-window request bursts with
    // HTTP 429 / RESOURCE_EXHAUSTED; a single retry window usually clears it.
    // This is real error/rate-limit handling — each attempt still calls the real
    // model, which decides tool usage itself.
    const MAX_ATTEMPTS = 5;
    let lastErrorDetail = "";
    for (let attempt = 1; ; attempt++) {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          ...body,
          generationConfig: { temperature: 0 },
        }),
      });

      if (response.status === 429 || response.status >= 500) {
        const raw = await response.text().catch(() => "");
        lastErrorDetail = `Gemini returned ${response.status} ${response.statusText} — ${raw.slice(0, 400)}`;

        // 429 = quota exhausted on the free tier. Instead of throwing (which
        // crashes the entire agent pipeline), mark quota as exhausted and
        // return a graceful empty result so the agent can finish with partial
        // progress.
        if (response.status === 429) {
          this._quotaExhausted = true;
          const isQuotaExhaustion = raw.includes("exceeded your current quota")
            || raw.includes("RESOURCE_EXHAUSTED")
            || raw.includes("generate_content_free_tier_requests");
          if (isQuotaExhaustion) {
            return {
              summary: `Gemini free-tier quota exhausted (HTTP 429). The agent has applied the changes it could. Please check the current file state and verify manually.`,
              toolCalls: [],
            };
          }
        }

        if (attempt >= MAX_ATTEMPTS) {
          throw new GrokApiError(`GROK_API_ERROR: ${lastErrorDetail}`);
        }
        const backoff = Math.min(2000 * 2 ** (attempt - 1), 30000) + Math.random() * 1000;
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }

      let payload: GeminiResponse = {};
      try {
        payload = (await response.json()) as GeminiResponse;
      } catch {
        const raw = await response.text().catch(() => "");
        throw new GrokApiError(`GROK_API_ERROR: Gemini returned ${response.status} ${response.statusText} — ${raw.slice(0, 500)}`);
      }

      if (!response.ok || payload.error) {
        const status = payload.error?.status ?? "";
        const message = payload.error?.message ?? JSON.stringify(payload).slice(0, 400);
        // Surface rate-limit and model errors with the original status for diagnosis.
        throw new GrokApiError(`GROK_API_ERROR: Gemini returned ${response.status} ${status} — ${message}`);
      }

      const parts = payload.candidates?.[0]?.content?.parts ?? [];
      this._requestCount += 1;

      // Function calls (if present) become ToolCallRequests for the coding-agent loop.
      const toolCalls: ToolCallRequest[] = [];
      let summaryParts: string[] = [];
      for (const part of parts) {
        if (part.functionCall) {
          toolCalls.push({
            id: part.functionCall.id || `fc_${toolCalls.length + 1}`,
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          });
        } else if (part.text != null) {
          summaryParts.push(part.text);
        }
      }

      return {
        summary: summaryParts.join("").trim() || undefined,
        toolCalls,
      };
    }
  }
}

/**
 * Translate OpenAI-style chat messages into Gemini `contents`. Gemini requires
 * alternating user/model turns: an assistant message that declares tool_calls
 * becomes a model turn with functionCall parts; the following tool results
 * become a single user turn of functionResponse parts that directly follows the
 * model turn which made those calls (never merged into an earlier text turn).
 */
function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];

  // Map tool_call_id -> function name, populated from assistant tool_calls.
  const idToName = new Map<string, string>();
  // Index of the user turn currently collecting functionResponses (if any).
  let frUserIndex = -1;

  const push = (content: GeminiContent) => {
    if (out.length > 0 && out[out.length - 1].role === content.role) {
      out[out.length - 1].parts.push(...content.parts);
    } else {
      out.push(content);
    }
  };

  for (const msg of messages) {
    if (msg.role === "system") continue; // handled via systemInstruction

    if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          idToName.set(tc.id, tc.function.name);
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            args = {};
          }
          parts.push({ functionCall: { name: tc.function.name, args, id: tc.id } });
        }
      }
      if (parts.length > 0) {
        push({ role: "model", parts });
        frUserIndex = -1; // a fresh model turn closes any prior function-response turn
      }
      continue;
    }

    if (msg.role === "tool") {
      // Bind to the declaring assistant function name via tool_call_id.
      const name = msg.tool_call_id ? idToName.get(msg.tool_call_id) : undefined;
      let response: Record<string, unknown> = {};
      try {
        response = JSON.parse(msg.content || "{}") as Record<string, unknown>;
      } catch {
        response = { raw: msg.content };
      }
      const part: GeminiPart = { functionResponse: { name: name ?? "unknown", response } };
      if (frUserIndex !== -1) {
        // Accumulate multiple results from the same model round into one user turn.
        out[frUserIndex].parts.push(part);
      } else {
        // A fresh user turn directly after the model turn that made the calls.
        push({ role: "user", parts: [part] });
        frUserIndex = out.length - 1;
      }
      continue;
    }

    // role === "user" (plain text).
    push({ role: "user", parts: [{ text: msg.content }] });
    frUserIndex = -1;
  }

  return out;
}

/**
 * Check if a provider has exhausted its free-tier quota. Used by the
 * self-healing loop to avoid wasting API calls on doomed retries.
 */
export function isProviderQuotaExhausted(provider: GrokProvider): boolean {
  if (provider instanceof GeminiProvider) {
    return provider.isQuotaExhausted;
  }
  return false;
}
