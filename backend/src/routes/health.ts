import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@dua/api-zod";

const router: IRouter = Router();

/**
 * Health endpoint.  Never exposes secrets — only whether the optional xAI
 * key is configured (so the UI can distinguish "no Grok" from "Grok down").
 * The generated zod schema validates the core payload; the capability flag
 * is appended as a non-secret extra field.
 */
function buildHealth(): { status: string; xai_configured: boolean } {
  const validated = HealthCheckResponse.parse({ status: "ok" });
  return { ...validated, xai_configured: Boolean(process.env.XAI_API_KEY) };
}

router.get("/healthz", (_req, res) => {
  res.json(buildHealth());
});

router.get("/health", (_req, res) => {
  res.json(buildHealth());
});

export default router;