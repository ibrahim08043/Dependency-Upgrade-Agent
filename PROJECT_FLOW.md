# PROJECT_FLOW — Current Implementation Audit

> Read-only documentation of the **actual** code as of 2026-08-30. Every claim below
> was traced through the source tree (`frontend/`, `backend/`, `shared/`). Nothing is
> assumed from the UI alone.

---

## 1. Overall Architecture

The application is a **TypeScript monorepo** (npm workspaces; optional pnpm via
`pnpm-workspace.yaml`). It is *not* a LangGraph/Python stack — the "agent" is a
hand-rolled, sequential Node/TypeScript pipeline executed inside the Express
process. Persistence is a JSON file, not a DB.

```
┌─────────┐   HTTP /api (Vite proxy or VITE_API_URL)   ┌──────────────────────────────┐
│ Browser │ ─────────────────────────────────────────▶ │ Express 5 backend (port 8000) │
│  React  │ ◀───────────────────────────────────────── │  backend/src/app.ts           │
└────┬────┘        JSON responses                      └──────────────┬───────────────┘
     │                                                               │
     │  routes (agent.ts)                                            │
     │   ┌───────────────────────┐                                   ▼
     │   │ repository-agent.ts   │ ── spawns ─▶ subprocesses: npm/pnpm install,
     │   │  (migration pipeline) │              git init/commit/diff, unzip/tar
     │   └──────────┬────────────┘                                   │
     │              │ reads/writes                                   │
     │              ▼                                                │
     │   migration-state.ts (JSON file)                        Isolated workspace
     │   backend/.data/migration-state.json                  <temp>/dependency-agent/<uuid>/
     │                                                                       │
     └───────────────────────────────────────────────────────────────────────┘
                                         │
                        External: npm registry, xAI/Grok (fetch), GitHub (fetch)
```

Key architectural facts:
- **Frontend** and **backend** communicate **only over HTTP**. The frontend never
  imports backend code.
- The frontend dev server proxies `/api → http://localhost:8000`
  (`frontend/vite.config.ts`), so in dev the browser makes same-origin requests.
  With `VITE_API_URL` set, `setBaseUrl()` rewrites relative `/api` URLs to the
  configured host (`frontend/src/api/client.ts`,
  `shared/api-client-react/src/custom-fetch.ts`).
- The backend CORS allows `http://localhost:5173` by default; configurable via
  `FRONTEND_ORIGIN` (`backend/src/app.ts:29-41`).
- Each migration job runs **synchronously inside the request handler trigger** but is
  fire-and-forget: `startMigration()` calls `void runMigration(id)` and returns the
  queued record immediately (`backend/src/lib/repository-agent.ts:510`).

---

## 2. Frontend (`frontend/`)

### Stack
- React 19.1, Vite 7, `wouter` routing, `@tanstack/react-query` v5, Tailwind 4,
  lucide-react icons, shadcn-style `components/ui/*` (55 components).
- Generated API client: `shared/api-client-react` (Orval). Hooks named
  `use<OperationId>` + query-key helpers, backed by `customFetch`
  (`shared/api-client-react/src/generated/api.ts`).
- Single route config lives in `frontend/src/App.tsx`.

### Pages / routes (`AppRouter`, `frontend/src/App.tsx:242-244`)

| Route | Component | What it does | API calls |
|-------|-----------|--------------|-----------|
| `/` | `Dashboard` | Overview: 4 stat cards (total / completed / running / failed migrations), recent-migrations table, static "Agent capabilities" list. | `GET /api/dashboard` (`useGetDashboard`), `GET /api/migrations` (`useListMigrations`, fallback list) |
| `/new` | `NewMigration` | Repository intake: choose ZIP upload **or** GitHub URL, analyze, then select dependency, target major, and mode (agentic/baseline) to start a migration. | `POST /api/repositories/upload` (`useUploadRepository`), `POST /api/repositories/github` (`useImportGithubRepository`), `GET /api/repositories/{id}` (`useGetRepository`, re-fetch after import), `POST /api/migrations` (`useCreateMigration`) |
| `/migration/:id` | `Workspace` | Live migration run view: stage tracker, agent event log, impact summary (files/usages), verification checkboxes (tests/build/typecheck/lint), links to diff & report, Cancel button. Polls every **4.5 s**. | `GET /api/migrations/{id}` (`useGetMigration`), `GET /api/migrations/{id}/events` (`useGetMigrationEvents`), `POST /api/migrations/{id}/cancel` (`useCancelMigration`) |
| `/migration/:id/diff` | `DiffPage` (within `MigrationFrame`) | Actual patch: files-changed/additions/deletions stats + per-file colored diff. No polling (single fetch). | `GET /api/migrations/{id}` (`useGetMigration`, header), `GET /api/migrations/{id}/diff` (`useGetMigrationDiff`) |
| `/migration/:id/report` | `ReportPage` (within `MigrationFrame`) | Final report: agent summary, changes made, research sources, impact, attempts, remaining issues, **Approve** button. | `GET /api/migrations/{id}` (`useGetMigration`, header), `GET /api/migrations/{id}/report` (`useGetMigrationReport`), `POST /api/migrations/{id}/approve` (`useApproveMigration`) |
| `*` | `NotFound` | 404 page (`frontend/src/pages/not-found.tsx`). | — |

### Important components (`frontend/src/App.tsx`)
- `Shell` — fixed sidebar + topbar frame; shows a static "API connected" pulse
  (never checks the API; it is decorative, `App.tsx:66`).
- `MigrationTable` — dashboard rows; each links to `/migration/:id`.
- `RepositoryDetails` — the dependency picker + target-major input + mode cards
  (`App.tsx:163-165`). **Key behavior**: by default it preselects
  `dependencies[0]` and the first numeric run of its version as the target major.
- `StageTrack` — 5 fixed stages `['Intake','Research','Impact map','Apply','Verify']`
  mapped from `migration.currentStage` (`App.tsx:25,188-191`).
- `EventLog` — renders `MigrationEvent[]`.
- `Checks` — renders `tests/build/typecheck/lint` pass/fail/skipped/running.
- `MigrationFrame` — shared shell for diff/report pages; polls the migration every **5 s**.
- `ErrorBoundary` — `frontend/src/components/error-boundary.tsx` (wraps app + router).

### User flow / navigation
```
/  (dashboard)
 └─ "Start a migration" → /new
/  (dashboard) recent rows → /migration/:id
/new  upload zip or github url → pick dependency + target major + mode → Start
      → /migration/:id (workspace)
/migration/:id → tabs: [Workspace] [Actual diff] [Final report]
/report → "Approve migration" button → POST approve → status flips to approved
```

### Loading / error / success states (as implemented)
- `Dashboard`: skeleton while both queries load; `ErrorState` (with Retry) only if
  **both** dashboard and migrations queries error.
- `NewMigration`: spinner icon while importing (`isPending`); error boxes with
  Retry for import failure and for create failure; disables Start until
  repo+dependency+targetMajor are set.
- `Workspace`: `LoadingWorkspace` skeleton while loading; `ErrorState` on error;
  event-log empty state; "Cancel run" only while `running`/`queued`; refresh button
  that refetches both queries.
- `DiffPage` / `ReportPage`: `MigrationFrame` skeleton/error; diff shows an empty
  state when `files.length === 0`; report shows an **Approve** button that calls the
  mutation and optimistically updates the migration query + invalidates the report.
- **No toasts/sonner are used anywhere** (the `use-toast.ts` hook is present in
  `frontend/src/hooks/` but never imported by `App.tsx`).

---

## 3. Backend (`backend/`)

### Entry & middleware (`backend/src/index.ts`, `app.ts`)
- Listens on `PORT` (default **8000**).
- Order: `pino-http` logging → CORS (allowlist) → `express.raw(...)` (for
  `application/zip`, `application/octet-stream`, `multipart/form-data`, 30mb limit)
  → `express.json()` → `express.urlencoded()`. The ZIP upload is parsed **manually**
  from the raw body (`readUploadedZip`, `backend/src/routes/agent.ts:21-36`) because
  there is no multer.

### Route table (all under `/api`, `backend/src/routes/`)

| Method | Path | Purpose | Handler / service |
|--------|------|---------|-------------------|
| GET | `/api/healthz`, `/api/health` | Health. Zod-validated `{status:"ok"}` + extra `xai_configured` flag (never the key). | `routes/health.ts` → `HealthCheckResponse` (api-zod) |
| GET | `/api/dashboard` | Counts (total/completed/running/failed) + last 8 migrations + hard-coded capabilities. | `routes/agent.ts:48` → `listMigrations()` |
| POST | `/api/repositories/upload` | Upload ZIP → extract → analyze → persist. Returns `publicRepository` (201). Errors → 400. | `routes/agent.ts:60` → `createRepositoryWorkspace()` + `analyzeRepository()` + `saveRepository()` |
| POST | `/api/repositories/github` | GitHub URL → fetch default-branch ZIP → analyze → persist (201). Errors → 400. | `routes/agent.ts:75` → `importGithubWorkspace()` + `analyzeRepository()` |
| GET | `/api/repositories/:id` | Repository analysis (404 if missing). | `routes/agent.ts:87` → `getRepository()` |
| GET | `/api/migrations` | All migrations, public shape only. | `routes/agent.ts:93` → `listMigrations()` |
| POST | `/api/migrations` | Create + start migration (202). Validates `repositoryId`, `dependency`, `targetMajor` (digits). | `routes/agent.ts:97` → `startMigration()` |
| GET | `/api/migrations/:id` | Migration job state (404 if missing). | `routes/agent.ts:110` → `getMigration()` |
| GET | `/api/migrations/:id/events` | Event log for that migration. | `routes/agent.ts:116` → `getEvents()` |
| GET | `/api/migrations/:id/diff` | The captured diff object. | `routes/agent.ts:120` → `migration.diff` |
| GET | `/api/migrations/:id/report` | Assembled report (summary, repository, impact, sources, changes, attempts, remaining issues). | `routes/agent.ts:126` |
| POST | `/api/migrations/:id/approve` | Approve **only if status === "completed"** (else 409). Sets status → `approved`. | `routes/agent.ts:152` → `saveMigration()` |
| POST | `/api/migrations/:id/cancel` | Cancel a running migration; sets status → `cancelled`. **No check** that it's actually running. | `routes/agent.ts:163` → `saveMigration()` |

> `publicRepository` strips `rootPath`; `publicMigration` strips `plan`,
> `impactFiles`, `sources`, `changes`, `attempts`, `remainingIssues`, `diff`
> (`routes/agent.ts:38-46`). So `GET /api/migrations*` and the dashboard never
> expose plan/diff — those are fetched separately via `/diff` and `/report`.

### Agent / migration pipeline — `backend/src/lib/repository-agent.ts`
There is **no LangGraph**; `runMigration()` is a sequential async function.

Order of operations in `runMigration()` (`repository-agent.ts:390-462`):

1. `migration.status = "running"`; emit event.
2. **Impact search** — `searchImpact()`: regex-matches `import/require` + bare
   identifier per source file (`.ts/.tsx/.js/.jsx/.mjs/.cjs`), skipping
   `node_modules/.git/dist/build`. Sets `impactFiles`, `affectedFiles`,
   `affectedUsages`.
3. **Registry research** — `researchDependency()`: `GET registry.npmjs.org/<name>`,
   picks the highest `<targetMajor>.x.y` (or `dist-tags.latest`).
4. **Grok plan** — `callGrok()` (see below). Fails hard if `XAI_API_KEY` is absent.
   The plan is parsed by `parsePlan()` from JSON (strips ``` fences).
5. **Apply** — initializes a git repo in the workspace (`git init`, config,
   add-all, "baseline" commit), then runs the package manager:
   - npm → `npm install <dep>@^<major>.0.0`
   - pnpm → `pnpm add <dep>@^<major>.0.0`
   - **Note:** `package-lock.json` is *not* committed — only the manifest change is
     captured in `git diff`, because the workspace starts untracked and only the
     install is run after the baseline commit.
6. **Verify** — `verifyMigration()` runs repo scripts `test`, `build`, `typecheck`,
   `lint` (only those present in `package.json` scripts) via the detected manager;
   each becomes `pass` / `fail` / `skipped`. Failures are pushed to
   `remainingIssues`.
7. **Diff** — `captureDiff()` runs `git diff --no-ext-diff --unified=3` + `git diff
   --numstat` and builds `MigrationRecord.diff`.
8. **Outcome** — passes if **none == "fail"**. Sets status `completed` or `failed`
   (`errorCode: "VERIFICATION_FAILURE"`), records a single attempt, and emits a
   success/error event.

### Mode difference (`agentic` vs `baseline`)
There is **no** branching on mode for the apply step:
```ts
if (migration.mode === "agentic") { update("migration", "Updating the dependency with the detected package manager"); }
else { update("migration", "Running baseline dependency update"); }
```
Both modes run the identical install + verify path. The only behavioral
distinction is the logged message and the label shown in the UI. The UI *promises*
"Agentic … iterates through verification failures," but the backend performs a
single attempt with **no retry / self-healing loop** anywhere.

### Job / workspace / subprocess details
- **Workspace**: `createWorkspaceRoot()` → `<temp>/dependency-agent/<uuid>/`
  (`backend/src/lib/workspace.ts:24-28`). Contains `repository.zip` (uploaded),
  `original/` (clean extract) and `workspace/` (working copy). The app's own source
  tree is never touched.
- **ZIP safety**: `listZipEntries()` lists entries, rejects >20,000 files or any
  absolute path / `..` segment; then extracts via `unzip` (preferred), `tar`, or
  PowerShell (`workspace.ts:67-110`). Cross-platform quirks handled (unzip `-v`
  probe; Windows tar backslash paths).
- **Command execution**: `runCommand()` uses `execFile`, `timeout: 120s`,
  `maxBuffer: 24KB`, and a constrained env (CI, npm audit/fund off);
  stdout/stderr truncated to 24KB. Exit codes never throw — callers inspect
  `result.code`.
- **GitHub import**: `importGithubWorkspace()` requires `github.com` hostname,
  fetches repo metadata (default branch), downloads the branch ZIP from
  `codeload.github.com`, then reuses the ZIP pipeline. Optional
  `Authorization: Bearer <GITHUB_TOKEN>` header.

### Database / job state — `backend/src/lib/migration-state.ts`
- JSON file at **`backend/.data/migration-state.json`** (anchored to the backend
  package root so it works from both `src` and bundled `dist`).
- Shape: `{ repositories: [], migrations: [], events: [] }` with full typed
  records (`RepositoryRecord`, `MigrationRecord`, `MigrationEvent`).
- Writes are serialized through a promise `writeQueue`; each write is atomic
  (temp file + rename), and the in-memory state is replaced after the write.
- Events capped at the last 5000.
- **No database**, no Drizzle, no Postgres. The old Drizzle `lib/db` package was
  removed in the refactor.

### xAI / Grok integration — `callGrok()` (`repository-agent.ts:278-304`)
- Direct HTTPS `fetch` to `https://api.x.ai/v1/chat/completions` with
  `Authorization: Bearer ${XAI_API_KEY}`.
- Model: `XAI_MODEL` env or `"grok-4-latest"`.
- **If `XAI_API_KEY` is unset → throws `GROK_NOT_CONFIGURED`** and the migration
  fails with that message in `remainingIssues`/event log (never a fake response).
- Prompt asks for "concise, factual JSON only"; the system prompt is hard-coded.
- ⚠️ `repository-agent.ts:6` still contains `import { ReplitConnectors } from
  "@replit/connectors-sdk"` but it is **never used** — dead import (the legacy
  Replit-proxy implementation was replaced by the direct xAI call).

### External integrations
| Integration | Status | Where |
|-------------|--------|-------|
| npm registry (`registry.npmjs.org`) | In production use | `researchDependency()` |
| xAI / Grok chat completions | Implemented; **gated behind `XAI_API_KEY`** | `callGrok()` |
| GitHub REST + codeload ZIP download | Implemented | `importGithubWorkspace()` |
| local subprocesses (`git`, `npm`, `pnpm`, `unzip`/`tar`) | In production use | `runCommand()`, `workspace.ts` |
| Replit connectors SDK | **Dead import**, not called | `repository-agent.ts:6` |

---

## 4. Complete End-to-End Flow (main use case)

Only stages that are actually implemented, with where they run:

```
1. Repository Input
   ├─ ZIP upload      → POST /api/repositories/upload
   │    → createRepositoryWorkspace(): safety-check + extract to <temp>/dependency-agent/<uuid>/
   │        (workspace.ts) , then analyzeRepository()
   └─ GitHub URL      → POST /api/repositories/github
        → importGithubWorkspace(): fetch default-branch ZIP → same ZIP pipeline
2. Analysis      → analyzeRepository(): find package.json (root or 1 wrapper dir deep),
                    parse deps (dependencies/dev/peer/optional), detect lockfile →
                    npm/pnpm/yarn/unsupported, language (TS vs JS), framework
                    (Next/Vite/React/Vue), scripts, status analyzed|invalid.
                    Persisted to migration-state.json. Returned to UI (repo card).
3. Dependency Selection  → UI: user picks a dependency + target major + mode;
                    POST /api/migrations → startMigration() validates repo is
                    "analyzed" and the dependency exists, creates & persists the job,
                    then fire-and-forgets runMigration().
4. Migration (automated, in-process):
   ├─ impact search (regex)
   ├─ registry research (latest <major>.x.y)
   ├─ Grok plan        (requires XAI_API_KEY, else job fails here)
   ├─ git init + baseline commit in workspace
   └─ package install  npm install / pnpm add <dep>@^<major>.0.0
5. Verification        → run repo `test`/`build`/`typecheck`/`lint` scripts,
                    each → pass|fail|skipped; failures recorded in remainingIssues.
6. Retry / Self-Healing  → NOT IMPLEMENTED. No loop, no re-plan, no corrective
                    step. Exactly one attempt; failures → status "failed".
7. Diff               → captureDiff(): git diff (unified=3) + numstat →
                    filesChanged/additions/deletions/files[].  Stored on the record.
8. Report             → GET /api/migrations/{id}/report assembles summary (from
                    plan), repository, impact, sources, changes, attempts,
                    remainingIssues.
9. Approval           → UI "Approve migration" (only enabled when completed) →
                    POST /api/migrations/{id}/approve → status "approved", event
                    logged. Cancel available while queued/running.
```

---

## 5. Feature / API Mapping

| Feature | Frontend | API | Backend | Status |
| ------- | -------- | --- | ------- | ------ |
| Health check | (generated `useHealthCheck` exists, **unused** in UI) | `GET /api/healthz`, `/api/health` | `routes/health.ts` | **Complete** (backend); not surfaced in UI |
| Dashboard summary | `useGetDashboard` (`/`) | `GET /api/dashboard` | `routes/agent.ts` | **Complete** |
| ZIP upload + analysis | `useUploadRepository` (`/new`) | `POST /api/repositories/upload` | `createRepositoryWorkspace` + `analyzeRepository` | **Complete** |
| GitHub import + analysis | `useImportGithubRepository` (`/new`) | `POST /api/repositories/github` | `importGithubWorkspace` + `analyzeRepository` | **Complete** |
| Repository detail | `useGetRepository` (`/new`, refresh after import) | `GET /api/repositories/{id}` | `getRepository` | **Complete** |
| List migrations | `useListMigrations` (`/`) | `GET /api/migrations` | `listMigrations` | **Complete** |
| Create migration | `useCreateMigration` (`/new`) | `POST /api/migrations` | `startMigration` | **Complete** |
| Migration state | `useGetMigration` (workspace, diff, report) | `GET /api/migrations/{id}` | `getMigration` | **Complete** |
| Event log | `useGetMigrationEvents` (workspace, 4.5s poll) | `GET /api/migrations/{id}/events` | `getEvents` | **Complete** |
| Diff view | `useGetMigrationDiff` (`/migration/:id/diff`) | `GET /api/migrations/{id}/diff` | `captureDiff` | **Complete** |
| Final report | `useGetMigrationReport` (`/migration/:id/report`) | `GET /api/migrations/{id}/report` | route assembler | **Complete** |
| Approve migration | `useApproveMigration` | `POST /api/migrations/{id}/approve` | `saveMigration` | **Complete** |
| Cancel migration | `useCancelMigration` | `POST /api/migrations/{id}/cancel` | `saveMigration` | **Complete** (no running-state guard) |
| Impact analysis | Workspace summary card | via migration/events | `searchImpact` | **Complete** (heuristic regex) |
| Registry research | Report "Research sources" | via report | `researchDependency` | **Complete** |
| Grok plan generation | Report summary/attempts | via migration | `callGrok` | **Partial** — implemented, **requires `XAI_API_KEY`**; without it every migration fails at this step |
| **Retry / self-healing** | UI card text claims "iterates through verification failures" | — | — | **Missing** — no such loop exists in code |
| Test/build/typecheck/lint verification | Workspace "Verification" card | via migration | `verifyMigration` | **Complete** |
| Repository list page | — (only recent in dashboard) | — | `listRepositories` exported but **no route maps it** | **Missing** (backend fn exists, unused) |
| Health in UI toggles "API connected" | uses static pulse, no fetch | — | — | **Missing** (decorative label) |
| Tests (frontend/backend) | — | — | — | **Missing** — no `*.test.*` anywhere; root `npm test` is an echo |

---

## 6. Current Gaps

### Implemented but not connected
- **`useHealthCheck` / `GET /api/healthz`** — generated client has it, backend serves
  it, **no UI component calls it**. The topbar "API connected" pulse is a hard-coded
  `<span>` (`App.tsx:66`), never derived from an actual request.
- **`listRepositories()`** (`migration-state.ts`) is exported but not exposed via any
  route and not used by the frontend. The dashboard only lists migrations.
- **`hashBytes()`** (`repository-agent.ts:514`) is exported and never called.
- **`use-toast.ts` / toast UI** in `frontend/src/hooks` + `components/ui/toast*` —
  never imported by the app; no toasts fire anywhere.
- **`@replit/connectors-sdk` / `ReplitConnectors`** — imported in
  `repository-agent.ts:6` but never used (dead dependency, still listed in
  `backend/package.json`).

### Frontend-only
- The `Shell` sidebar "AGENT STATUS: Ready for a repository" and topbar "API
  connected" are static copy.
- The `RepositoryDetails` copy for "Agentic migration … iterates through
  verification failures" describes behavior the backend does not implement.
- All 55 `components/ui/*` shadcn components are present; only a small subset is
  actually rendered by pages (`card`, `button` via classes, `toast` files unused,
  etc.).

### Backend-only
- The **`cancel` endpoint has no guard**: it will mark any migration (including one
  already `completed`/`approved`) as `cancelled` — the frontend only *offers* Cancel
  while running/queued, but the API does not enforce it.
- **`errorCode` for Grok failures is `"Error"`** (generic) because
  `String(error).split(":")[0]` yields `"Error"` for `Error: GROK_NOT_CONFIGURED …`
  (`repository-agent.ts:457`). `GROK_NOT_CONFIGURED` is visible in
  `remainingIssues`/events instead.
- Migration jobs are **in-memory + fire-and-forget**: if the backend process stops
  while a job runs, the job is lost (state file only reflects the last saved step).
  No queue, no worker, no resume.

### Partially implemented
- **Grok integration**: fully written, but unusable without `XAI_API_KEY`; no
  retries, no error recovery, `temperature: 0` single-shot JSON.
- **`agentic` vs `baseline` modes**: identical execution path; only messaging/label
  differs.
- **Diff capture**: only captures the *package.json manifest* change — the
  install/verify steps may produce other changes (e.g. lockfile) but no lockfile is
  tracked, and any files changed by scripts are not staged, so `git diff` reflects
  the manifest line(s) only.
- **Repository analysis**: lockfile detection only recognises files at root or one
  level deep; `yarn` is detected as `packageManager: "unsupported"` and migrations
  then fail at `UNSUPPORTED_PACKAGE_MANAGER`.

### Missing
- **Retry / self-healing / failure diagnosis** — the headline "agentic" behavior is
  absent. One attempt, then `failed` (or on Grok failure, `failed` before apply).
- **Automated tests** — no test suites in `frontend/`, `backend/`, or `shared/`.
- **`GET /api/repositories`** (list) and **`DELETE`/repository picker** — not implemented.
- **WebSocket/SSE streaming** — the UI simulates liveness via 4.5s polling.
- **Push to GitHub / creating a PR** — explicitly not implemented; the app works in
  an isolated temp workspace and only reports a diff.

### Currently broken / risky (discoverable from code)
- **Migration cannot complete without `XAI_API_KEY`** — `callGrok` is unconditional
  for both modes; every attempt stops at planning unless the key is configured.
  (This is intentional — no fake AI — but it means the "completed → approve" path
  is unreachable in a key-less environment.)
- **ZIP-only extraction for GitHub** relies on `unzip`/`tar`/PowerShell presence;
  if none exists the upload fails with `REPOSITORY_INVALID`.
- **`express.raw` + manual multipart parsing** is brittle for non-
  `multipart/form-data` clients (falls back to treating the raw body as the zip),
  and the frontend's generated `uploadRepository` sends a real `FormData` with
  `name="file"`, which the parser matches.
- The `errorCode`/`parsePlan` error path surfaces raw xAI errors as `["Error: …"]`.

---

## Current System Summary

At runtime, on `npm run dev`, the app is a **single-page "Dependency Upgrade Agent
command center"** backed by an Express API over a JSON file. It can **actually**:

1. Accept a **real ZIP repository** (or a **public GitHub URL**) and analyse it:
   detect `package.json`, all dependency sections, lockfile → package manager,
   language, framework, and scripts (verified working for a real JS zip).
2. Let the user pick a **dependency, target major, and mode**, then start a
   migration that runs **sequentially in the backend**: regex impact scan, a live
   **npm-registry** lookup for the latest release in the chosen major, a **Grok
   plan** (only with `XAI_API_KEY`; otherwise it fails with `GROK_NOT_CONFIGURED`),
   then a **real install** (`npm install` / `pnpm add`) inside an isolated
   `<temp>/dependency-agent/<uuid>/` git workspace.
3. Run the repository's **`test`/`build`/`typecheck`/`lint`** scripts with 120s
   timeouts, record each result, capture an actual **`git diff`**, assemble a
   **report**, and — only on full verification success — let the user **approve**;
   otherwise report `failed` with the remaining issues.

There is **no LangGraph**, no retry/diagnosis loop, no queue, no real database, and
no code push. The celebrated "agentic self-healing" flow is UI copy only — in code,
a migration is a single deterministic pass that halts permanently on any failure
(the most common being the missing Grok key). The system is a functioning
**single-run migration tool with a strong UI shell**; everything up to the external
Grok step is end-to-end proven, and the Grok/YAAS boundary is the main remaining
dependency to enable a full run.