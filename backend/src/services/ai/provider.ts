import { XaiGrokProvider } from "./grok";
import type { GrokProvider } from "./types";
import { GrokConfigError } from "./types";

let cachedProvider: GrokProvider | null = null;

/**
 * Returns a configured Grok provider, throwing GrokConfigError when the
 * backend has no XAI_API_KEY.  The instance is lazily cached per process.
 */
export function getGrokProvider(): GrokProvider {
  if (!process.env.XAI_API_KEY) {
    throw new GrokConfigError(
      "GROK_NOT_CONFIGURED: XAI_API_KEY is not set on the backend. Add it to the backend environment to enable the agent.",
    );
  }
  if (!cachedProvider) {
    cachedProvider = new XaiGrokProvider();
  }
  return cachedProvider;
}