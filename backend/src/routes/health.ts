import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@dua/api-zod";

const router: IRouter = Router();

/**
 * Liveness: "Is the process alive?"
 * Never exposes secrets.
 */
function buildHealth(): { status: string; xai_configured: boolean; gemini_configured: boolean } {
  const validated = HealthCheckResponse.parse({ status: "ok" });
  return {
    ...validated,
    xai_configured: Boolean(process.env.XAI_API_KEY),
    gemini_configured: Boolean(process.env.GEMINI_API_KEY),
  };
}

/**
 * Readiness: "Can the application accept work?"
 * Currently always ready — the app can serve requests even without AI keys
 * (baseline mode works, research/impact still run). AI keys are optional.
 */
function buildReadiness(): { status: string; ready: boolean; reason: string } {
  return { status: "ready", ready: true, reason: "Service is operational" };
}

router.get("/healthz", (_req, res) => {
  res.json(buildHealth());
});

router.get("/health", (_req, res) => {
  res.json(buildHealth());
});

router.get("/readyz", (_req, res) => {
  res.json(buildReadiness());
});

router.get("/ready", (_req, res) => {
  res.json(buildReadiness());
});

export default router;
