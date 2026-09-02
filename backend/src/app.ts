import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
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
