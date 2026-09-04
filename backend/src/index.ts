import app from "./app";
import { logger } from "./lib/logger";

// --- Environment diagnostics (safe: never log key values) ---
const xaiKey = process.env.XAI_API_KEY;
const geminiKey = process.env.GEMINI_API_KEY;
logger.info(
  {
    XAI_API_KEY_present: Boolean(xaiKey),
    XAI_API_KEY_length: xaiKey?.length ?? 0,
    GEMINI_API_KEY_present: Boolean(geminiKey),
    GEMINI_API_KEY_length: geminiKey?.length ?? 0,
    NODE_ENV: process.env.NODE_ENV ?? "unset",
  },
  "Environment loaded",
);

if (!xaiKey && !geminiKey) {
  logger.warn("No AI provider API keys configured — agentic migrations will be skipped");
}

const rawPort = process.env["PORT"] ?? "8000";
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port, nodeEnv: process.env.NODE_ENV ?? "development" }, "Server listening");
});

// --- Graceful shutdown ---
let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Received shutdown signal — closing server");

  // Stop accepting new connections, let in-flight requests finish.
  server.close((err) => {
    if (err) {
      logger.error({ err }, "Error closing HTTP server");
    } else {
      logger.info("HTTP server closed");
    }
    // Give pending I/O a moment to flush (pino streams, file writes).
    setTimeout(() => {
      logger.info("Shutdown complete");
      process.exit(0);
    }, 500);
  });

  // Force exit after 10 seconds if graceful shutdown hangs.
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
