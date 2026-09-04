import { XaiGrokProvider } from "./grok";
import { GeminiProvider } from "./gemini";
import type { GrokProvider } from "./types";
import { GrokConfigError, invalidXaiKeyReason } from "./types";

export { invalidXaiKeyReason };

export type ProviderKind = "grok" | "gemini";

/**
 * Resolve which provider the backend should use. AI_PROVIDER is the explicit
 * selection ("gemini" | "groq" | "xai"); when unset we auto-detect from the
 * configured API keys (GEMINI_API_KEY -> Gemini, else the Grok/xAI slot).
 */
export function resolveProviderKind(env: NodeJS.ProcessEnv = process.env): ProviderKind {
  const explicit = (env.AI_PROVIDER ?? "").toLowerCase();
  if (explicit === "gemini") return "gemini";
  if (explicit === "groq" || explicit === "xai" || explicit === "grok") return "grok";
  // No explicit selection: auto-detect from which API key is present.
  if (env.GEMINI_API_KEY) return "gemini";
  return "grok";
}

/** Whether a real (non-scripted) provider is configured with an API key. */
export function isProviderConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GEMINI_API_KEY || env.XAI_API_KEY || env.GROQ_API_KEY);
}

let cachedProvider: { kind: ProviderKind; provider: GrokProvider } | null = null;

/**
 * Returns a configured provider, throwing GrokConfigError when the backend has
 * no (or an obviously invalid) API key for the selected provider. The instance
 * is lazily cached per process, keyed by provider kind so an explicit provider
 * switch is honored without leaking one provider's client into another.
 */
export function getGrokProvider(env: NodeJS.ProcessEnv = process.env): GrokProvider {
  const kind = resolveProviderKind(env);
  if (cachedProvider && cachedProvider.kind === kind) {
    return cachedProvider.provider;
  }
  let provider: GrokProvider;
  if (kind === "gemini") {
    provider = new GeminiProvider(env);
  } else {
    const problem = invalidXaiKeyReason(env.XAI_API_KEY ?? env.GROQ_API_KEY ?? "");
    if (problem) {
      throw new GrokConfigError(`GROK_NOT_CONFIGURED: ${problem} Add it to the backend environment to enable the agent.`);
    }
    provider = new XaiGrokProvider(env);
  }
  cachedProvider = { kind, provider };
  return provider;
}
