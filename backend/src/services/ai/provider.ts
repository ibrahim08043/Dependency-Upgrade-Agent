import { XaiGrokProvider } from "./grok";
import type { GrokProvider } from "./types";
import { GrokConfigError, invalidXaiKeyReason } from "./types";

let cachedProvider: GrokProvider | null = null;

export { invalidXaiKeyReason };

/**
 * Returns a configured Grok provider, throwing GrokConfigError when the
 * backend has no (or an obviously invalid) XAI_API_KEY.  The instance is
 * lazily cached per process.
 */
export function getGrokProvider(): GrokProvider {
  const problem = invalidXaiKeyReason(process.env.XAI_API_KEY ?? "");
  if (problem) {
    throw new GrokConfigError(`GROK_NOT_CONFIGURED: ${problem} Add it to the backend environment to enable the agent.`);
  }
  if (!cachedProvider) {
    cachedProvider = new XaiGrokProvider();
  }
  return cachedProvider;
}