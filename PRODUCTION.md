# Production Deployment Guide

## Prerequisites

- **Node.js** ≥ 22
- **npm** ≥ 10
- **git** (required at runtime for baseline snapshots and diff capture)
- **Docker** (optional, for containerised deployment)

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | No | Set to `production` to enable static serving and production mode |
| `PORT` | No | Server port (default: `8000`) |
| `FRONTEND_ORIGIN` | No | Comma-separated CORS origins (default: `http://localhost:5173`) |
| `XAI_API_KEY` | No* | xAI/Groq API key for AI-assisted mode |
| `GEMINI_API_KEY` | No* | Google AI Studio key for Gemini provider |
| `GITHUB_TOKEN` | No | GitHub PAT for private repo cloning |
| `LOG_LEVEL` | No | Pino log level (default: `info`) |

\* At least one AI key enables agentic mode. Without any key, baseline mode applies diffs directly.

---

## Local Development

```bash
# Install dependencies
cd backend && npm install
cd ../frontend && npm install
cd ../shared/api-zod && npm install
cd ../shared/api-client-react && npm install

# Run backend (port 8000)
cd backend && npm run dev

# Run frontend dev server (port 5173, proxies /api to backend)
cd frontend && npm run dev
```

---

## Production Build & Run

```bash
# 1. Build shared packages
cd shared/api-zod && npm install && cd ../api-client-react && npm install

# 2. Build frontend
cd frontend && npm run build

# 3. Build backend
cd backend && node ./build.mjs

# 4. Run
cd backend && NODE_ENV=production node dist/index.mjs
```

The backend serves `frontend/dist/public/` as static files in production mode.
SPA fallback routes all non-API GETs to `index.html`.

---

## Docker

```bash
# Build and run
docker compose up --build

# Or standalone
docker build -t dependency-upgrade-agent .
docker run -p 8000:8000 -e XAI_API_KEY=... dependency-upgrade-agent
```

The multi-stage Dockerfile:
1. Builds frontend in `node:22-slim`
2. Builds backend in `node:22-slim`
3. Runs in a slim runtime image with `git` installed

Migration data persists via the `migration-data` Docker volume.

---

## Health Endpoints

| Endpoint | Purpose | Response |
|---|---|---|
| `GET /api/healthz` | Liveness probe | `{ status, version, uptime, node_env, xai_configured, gemini_configured }` |
| `GET /api/readyz` | Readiness probe | `{ status: "ready", ready: true, reason }` |

Both return HTTP 200. Readiness is always true — the service operates in baseline mode without AI keys.

---

## CI Pipeline

`.github/workflows/ci.yml` runs on push/PR to `main`:

- **Backend job**: install → typecheck → 54 tests
- **Frontend job**: install → typecheck → production build

---

## Security Notes

- API keys are never exposed to the frontend or logged
- All routes are behind `/api` prefix; production static serving skips `/api` paths
- ZIP uploads are size-limited (30 MB body, configurable per-entry limits)
- Path traversal is blocked during ZIP extraction
- Secrets are redacted in health endpoint output (`sk-redacted`)
- Graceful shutdown handles SIGTERM/SIGINT with 10s force timeout
