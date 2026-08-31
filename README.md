# Dependency Major-Version Upgrade Agent

An AI-assisted workspace for migrating JavaScript/TypeScript repositories across
major dependency versions. You bring a repository (ZIP or GitHub URL), the agent
analyzes it, researches the target release, plans and applies a real dependency
upgrade in an isolated temp workspace, runs the repository's verification
commands, and shows you the **actual diff** and a **final report** for approval.

```
                Dependency
              Migration Agent
                     │
         ┌───────────┴───────────┐
         │                       │
     FRONTEND                 BACKEND
   React / Vite              Express 5
         │                       │
         └────── HTTP /api ──────┘
                                 │
                            Grok / xAI (optional)
                                 │
                        Isolated repo workspace
                                 │
                        Tests / Build / Diff
```

## Requirements

- **Node ≥ 20** (developed on Node 24) and **npm** (or pnpm)
- **git** (used to snapshot the working repo and produce diffs)
- A ZIP extractor: on Unix, `unzip`; on Windows, Git-Bash ships `unzip` and
  native Windows ships `tar`/PowerShell — the backend probes for one.
- Optional: an **xAI API key** for Grok-powered migration planning.
  Without it, migrations still run end-to-end but stop with a clear
  `GROK_NOT_CONFIGURED` error at the planning step (no fake responses).

## Layout

```
frontend/   React 19 + Vite + wouter + TanStack Query + orval-generated API client
backend/    Express 5 API + migration agent (TypeScript, esbuild bundle)
shared/     api-spec (OpenAPI), api-client-react (typed hooks), api-zod (schemas)
```

## Quick start

```bash
npm install
npm run dev
```

This starts both processes:

- Frontend → http://localhost:5173
- Backend  → http://localhost:8000 (health: http://localhost:8000/api/healthz)

In dev, the frontend proxies `/api/*` to the backend, so no CORS is involved on
the happy path.

### Individual processes

```bash
npm run dev:backend   # backend only (port 8000)
npm run dev:frontend  # frontend only (port 5173)
```

### Build / typecheck / test

```bash
npm run build        # backend bundle + frontend production build
npm run typecheck    # tsc --noEmit for backend and frontend
npm test             # placeholder — run-test suites live in backend/tests + frontend/tests
```

## Environment

Copy `.env.example` and fill in what you need. **Backend secrets live only in
the backend process** — `XAI_API_KEY` and `GITHUB_TOKEN` are never `VITE_*`
prefixed and never reach the browser.

| Variable            | Process  | Purpose                                           |
|---------------------|----------|---------------------------------------------------|
| `PORT`              | Backend  | API port (default `8000`)                         |
| `FRONTEND_ORIGIN`   | Backend  | Allowed CORS origins (default `http://localhost:5173`) |
| `XAI_API_KEY`       | Backend  | Grok/xAI key for migration planning               |
| `XAI_MODEL`         | Backend  | Optional Grok model override                      |
| `GITHUB_TOKEN`      | Backend  | GitHub auth for private repo analysis             |
| `LOG_LEVEL`         | Backend  | pino log level                                    |
| `VITE_API_URL`      | Frontend | Backend origin for the API client (used when not proxied) |

## API overview

All endpoints are under `/api` (see `shared/api-spec/openapi.yaml`):

```
GET  /api/healthz | /api/health           health (includes xai_configured flag)
GET  /api/dashboard                       summary counts + recent migrations
POST /api/repositories/upload             upload and analyze a ZIP repository
POST /api/repositories/github             import and analyze a GitHub repository
GET  /api/repositories/{id}               repository analysis
GET  /api/migrations                      list recent migrations
POST /api/migrations                      create and start a migration
GET  /api/migrations/{id}                 migration job state
GET  /api/migrations/{id}/events          event log
GET  /api/migrations/{id}/diff            actual patch
GET  /api/migrations/{id}/report          final report
POST /api/migrations/{id}/approve         approve completed migration
POST /api/migrations/{id}/cancel          cancel running migration
```

The frontend's typed API client is generated from the OpenAPI spec via Orval:

```bash
# after editing shared/api-spec/openapi.yaml
cd shared/api-spec && npm run codegen
```

## How a migration works

1. **Intake** — a ZIP is uploaded or a GitHub URL is cloned into an isolated
   temp workspace (`<temp>/dependency-agent/<uuid>/`). ZIPs are validated for
   unsafe paths before extraction. The application's own source directory is
   never used as a workspace.
2. **Analysis** — `package.json`, lockfiles, dependencies, scripts, language,
   and framework are detected. Dependencies are searched for impact usages.
3. **Research** — the target major's latest release is resolved from the npm
   registry; Grok (when configured) produces a migration plan.
4. **Apply** — the workspace is git-snapshotted (baseline commit), then the
   dependency is upgraded with the detected package manager (`npm` / `pnpm`).
5. **Verify** — `test`, `build`, `typecheck`, `lint` are run with timeouts; the
   actual `git diff` is captured.
6. **Approve** — you review the diff and report and approve or cancel.

Persistence is a JSON state file (`backend/.data/migration-state.json`) — no
database is required for the MVP. Command execution has bounded timeouts, output
is truncated, and retries are bounded.

## Local development notes

- The backend bundles with esbuild (`backend/build.mjs`); `npm run dev:backend`
  builds once then runs the bundle.
- The frontend dev server proxies `/api` to the backend; set `VITE_API_URL`
  only when serving a static build separately from the API.
- The workspace and state dirs are runtime artifacts and are git-ignored.