import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { existsSync } from "node:fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// CORS: allow the actual frontend dev origin (configurable). Defaults to the
// Vite dev server on localhost:5173 when FRONTEND_ORIGIN is unset/empty.
const defaultOrigin = "http://localhost:5173";
const configuredOrigin = process.env.FRONTEND_ORIGIN;
const allowedOrigins = configuredOrigin
  ? configuredOrigin.split(",").map((origin) => origin.trim()).filter(Boolean)
  : [defaultOrigin];
app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.use(
  express.raw({
    type: ["application/zip", "application/octet-stream", "multipart/form-data"],
    limit: "30mb",
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// --- Production static file serving ---
// In production, serve the frontend build from frontend/dist/public/.
// In development, the Vite dev server handles the frontend via proxy.
const isProduction = process.env.NODE_ENV === "production";
const frontendDist = path.resolve(import.meta.dirname, "../../frontend/dist/public");
if (isProduction && existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  // SPA fallback: any non-API GET that didn't match a static file returns index.html
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(frontendDist, "index.html"));
  });
  logger.info({ path: frontendDist }, "Serving frontend static files");
}

// Express error handler: surface body-parser failures (e.g. oversized uploads)
// as clean JSON instead of default HTML. Keeps the contract frontend-friendly.
app.use(
  (
    error: { type?: string; status?: number; message?: string },
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (error?.type === "entity.too.large" || error?.message?.toLowerCase().includes("too large")) {
      res.status(413).json({ error: "FILE_TOO_LARGE: upload exceeds the 30 MB body limit" });
      return;
    }
    next(error);
  },
);

export default app;
