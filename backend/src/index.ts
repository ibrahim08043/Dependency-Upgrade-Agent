import app from "./app";
import { logger } from "./lib/logger";

// --- Environment diagnostics (safe: never log key values) ---
const xaiKey = process.env.XAI_API_KEY;
logger.info(
  {
    XAI_API_KEY_present: Boolean(xaiKey),
    XAI_API_KEY_length: xaiKey?.length ?? 0,
    NODE_ENV: process.env.NODE_ENV ?? "unset",
  },
  "Environment loaded",
);

const rawPort = process.env["PORT"] ?? "8000";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
