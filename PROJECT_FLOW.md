# PROJECT_FLOW — Complete Architecture & Implementation Audit

> **Single source of truth** for the current project, re-derived from the actual
> source tree on 2026-09-01. Every claim was traced through `frontend/`,
> `backend/`, and `shared/`. Nothing is assumed from the UI alone.
>
> **Stack summary up front:** TypeScript pnpm monorepo (`frontend` + `backend` +
> `shared/*`). Frontend = Vite 7 + React 19 + wouter + TanStack Query. Backend =
> Express 5 + a hand-rolled agent/tool-calling loop over the xAI/Grok chat API
> (+ real npm-registry / GitHub HTTP fetches and real `git`/`npm`/`pnpm`
> subprocesses). Persistence = a JSON file. There is **no database, no
> LangGraph, no WebSocket/SSE** — the UI "streams" via polling.

---

## 1. Overall Architecture

```
┌──────────┐   HTTP /api (Vite proxy OR VITE_API_URL)    ┌──────────────────────────────┐
│ Browser  │ ─────────────────────────────────────────▶ │ Express 5 backend (port 8000) │
│ React 19 │ ◀───────────────────────────────────────── │  backend/src/index.ts → app.ts │
└────┬─────┘          JSON responses                     └──────────────┬───────────────┘
     │                                                                    │ routes/
     │                                                                    │  health.ts, agent.ts
     │                                                                    ▼
     │                                          lib/repository-agent.ts (migration pipeline)
     │                                          ├─ lib/research.ts      (npm + docs fetch)
     │                                          ├─ lib/impact.ts         (usage scanner)
     │                                          ├─ lib/risk.ts           (research↔usage risk)
     │                                          ├─ lib/synthesis.ts      (Grok synthesis + fallback)
     │                                          ├─ lib/heal.ts           (failure diagnosis)
     │                                          ├─ agents/coding-agent.ts (tool loop + 10 tools)
     │                                          ├─ services/ai/grok.ts    (xAI chat completions)
     │                                          └─ lib/git.ts / run-command.ts / workspace.ts / zip.ts
     │                                                                    │
     │                                            state file: backend/.data/migration-state.json
     │                                            isolated workspace: <temp>/dependency-agent/<uuid>/
     └────────────────────────────────────────────────────────────────────┘
            External: registry.npmjs.org · GitHub/api · xAI/Grok (fetch)
```

Architectural facts (verified):
- **Frontend ↔ backend communicate only over HTTP.** The frontend never imports backend code.
- Dev-time `/api` is proxied to `http://localhost:8000` (`frontend/vite.config.ts`).
  With `VITE_API_URL` set, `frontend/src/api/client.ts` rewrites the base URL.
- Backend CORS default origin is `http://localhost:5173`, configurable via
  `FRONTEND_ORIGIN` (`backend/src/app.ts`).
- Migrations run **fire-and-forget inside the request handler**: `startMigration()`
  persists a queued job then calls `void runMigration(id)` and returns immediately
  (`backend/src/lib/repository-agent.ts`).
- Logger: pino + pino-http, with `authorization` / `cookie` / `set-cookie` redacted.
- Backend is bundled to `dist/` by `backend/build.mjs` (esbuild); production runs
  `node dist/index.mjs`. The `.data/` state dir is anchored so `src` and `dist`
  share the same file.

---

## 2. Frontend (`frontend/`)

### Stack
- React 19.1 · Vite 7 · **wouter** routing (⚠️ not React Router) · TanStack Query v5 ·
  Tailwind 4 (CSS-first in `index.css`) · lucide-react icons ·
  a shadcn-style `components/ui/*` collection (~50 files, **mostly unused**).
- Generated API client `@dua/api-client-react` (Orval) — hooks `use<OperationId>`,
  query-key helpers, `customFetch`.
- All routes + all pages live in **one file**: `frontend/src/App.tsx`.

### Pages / routes (`AppRouter`, `App.tsx:422-424`)

| # | Route | Component | Purpose | API calls | Polling |
|---|-------|-----------|---------|-----------|---------|
| 1 | `/` | `Dashboard` | Overview: 4 stat cards (total/completed/running/failed), recent-migrations table, static capabilities list. | `GET /dashboard` (`useGetDashboard`), `GET /migrations` (`useListMigrations`, fallback rows) | none |
| 2 | `/new` | `NewMigration` | Intake: **GitHub URL OR ZIP upload** (source tabs) → analyze → pick a real dependency + target major + mode → start migration. ZIP pane: drag-drop/click-to-browse `.zip` only, client-side size + extension validation, name/size shown, upload/error/success states, remove/reselect. | GitHub: `POST /repositories/github` (`useImportGithubRepository`); ZIP: `POST /repositories/upload` (`useUploadRepository`); both then `GET /repositories/{id}` (`useGetRepository` refresh); `POST /migrations` (`useCreateMigration`) | none |
| 3 | `/migration/:id` | `Workspace` | Live run view: stage tracker, event log, impact summary, risk stats, verification checks, research panel, impact map, attempts timeline, verification-command panel, baseline result, Agent activity card, Diff/Report links, Cancel. | `GET /migrations/{id}` (`useGetMigration`), `GET /migrations/{id}/events` (`useGetMigrationEvents`), `POST /migrations/{id}/cancel` (`useCancelMigration`) | 4.5 s (migration + events) |
| 4 | `/migration/:id/diff` | `DiffPage` (inside `MigrationFrame`) | Actual patch: files-changed/additions/deletions + per-file colored diff. | `GET /migrations/{id}` (header), `GET /migrations/{id}/diff` (`useGetMigrationDiff`) | 5 s (frame) |
| 5 | `/migration/:id/report` | `ReportPage` (inside `MigrationFrame`) | Final report: agent conclusion, changes, research sources, research panel, impact map, impact summary, attempts, verification commands, baseline, approval gate (**Approve** / **Reject**), remaining issues. | `GET /migrations/{id}` (header), `GET /migrations/{id}/report` (`useGetMigrationReport`), `POST /migrations/{id}/approve` (`useApproveMigration`), `POST /migrations/{id}/reject` (`useRejectMigration`) | 5 s (frame) |
| * | `*` | `NotFound` | 404 page. | — | — |

**Total routes: 6** (5 app pages + fallback). All five pages are defined inline in `App.tsx`.

### Important components (`frontend/src/App.tsx`)
- **`Shell`** — fixed left sidebar + topbar frame, wraps every route.
  - Sidebar: brand logo (`frontend/public/logo.png`), nav groups, footer + a
    **collapse toggle** button. Collapsed state is persisted in
    `localStorage['dua.sidebar.collapsed']`. Icons get radix tooltips when collapsed.
  - Topbar: mobile hamburger (off-canvas sidebar ≤680px), breadcrumb crumb
    ("Command center / …"), and a **static "API connected" pulse** (decorative —
    the health endpoint is never called by the UI).
- `SidebarNavLink` — wouter `Link` wrapped in a radix `Tooltip` (tooltip shown only
  when sidebar collapsed).
- `MigrationTable` — dashboard rows; each row links to `/migration/:id`
  (repository name + run id, dependency + mode, `old → target`, status pill, updated, open arrow).
- `RepositoryDetails` — dependency picker (one per dep, shows section + version),
  target-major numeric input, mode cards (agentic / baseline). **Pre-selects
  `dependencies[0]`** and the first numeric run of its version as the target major.
- `StageTrack` — 5 fixed stages `['Intake','Research','Impact map','Apply','Verify']`
  mapped from `migration.currentStage` (`App.tsx:27`).
- `EventLog` — renders `MigrationEvent[]` by level color.
- `Checks` — tests/build/typecheck/lint pass/fail/skipped/running.
- `ResearchSection` + `ResearchGroup` + `ConfChip` — Phase 2 research panel
  (confidence chip, categorized findings, source cards with status).
- `ImpactMap` + `ImpactRow` — risk summary + per-file grouped findings, risk legend.
- `AttemptsTimeline` — self-healing attempts (PASS/FAIL, diagnosis, corrective patch).
- `VerificationPanel` — rich per-command records (status, exit code, stdout/stderr, duration).
- `AgentActivity` — agent state: status dot, current action, agent summary,
  files modified, files inspected, **last 20 tool calls** (tool + success dot + result summary).
- `MigrationFrame` — shared diff/report header: title, status pill, repo/dep/version,
  "Back to workspace", stage track, subnav (Workspace / Actual diff / Final report).
- `ErrorBoundary` — `frontend/src/components/error-boundary.tsx` (wraps app + router).
- `NotFound` — `frontend/src/pages/not-found.tsx` (uses `components/ui/card`).

### Navigation
- **Sidebar items** (all preserved):
  - Group "Workspace": **Overview** (`/`, `Layers3`), **New migration** (`/new`, `Zap`).
  - Group "Current run": **Migration workspace** / **No active run** (`CircleDot`,
    href = current migration path when active, else `/`).
  - Footer: AGENT STATUS copy + Collapse/Expand toggle.
  - Collapse → 68 px icon rail (labels, group headers, footer hidden; tooltips on hover).
  - ≤680px → off-canvas overlay opened by the hamburger; the collapse feature is
    disabled on mobile by CSS scoping (`min-width: 681px`).
- **Header / breadcrumb**: `Command center › {Migration run | New migration | Overview}`.
- **Secondary subnav** on migration pages: `Workspace | Actual diff | Final report`.

### Frontend — API integration table

| Frontend Feature | Method | Endpoint | Purpose | Used by |
| ---------------- | ------ | -------- | ------- | ------- |
| Dashboard summary | GET | `/api/dashboard` | counts + recent + capabilities | Dashboard |
| List migrations | GET | `/api/migrations` | recent rows fallback | Dashboard |
| Import GitHub repo | POST | `/api/repositories/github` | analyze a GitHub repo | NewMigration |
| Upload ZIP repo | POST | `/api/repositories/upload` | secure extract + analyze a ZIP | NewMigration (ZIP tab) |
| Repository detail | GET | `/api/repositories/{id}` | refreshed repo analysis | NewMigration |
| Create migration | POST | `/api/migrations` | start a migration job | NewMigration |
| Migration state | GET | `/api/migrations/{id}` | live job state | Workspace, MigrationFrame |
| Event log | GET | `/api/migrations/{id}/events` | live events | Workspace |
| Diff | GET | `/api/migrations/{id}/diff` | actual patch | DiffPage |
| Report | GET | `/api/migrations/{id}/report` | final report | ReportPage |
| Approve | POST | `/api/migrations/{id}/approve` | approve a completed run | ReportPage |
| Reject | POST | `/api/migrations/{id}/reject` | reject a completed run | ReportPage |
| Cancel | POST | `/api/migrations/{id}/cancel` | cancel a running run | Workspace |

**Frontend-integrated endpoints: 13** (all actively called by `App.tsx`, including the ZIP upload).

**Defined but NOT wired to the UI** (generated client has a hook; `App.tsx` never calls it):
- `GET /api/healthz` (`useHealthCheck`) and `GET /api/health` (`useHealthCheckAlias`) — served, unused (topbar "API connected" is a static pulse).

> ✅ **Counts:** Total unique API endpoints the frontend can hit = **13 used**, plus
> **2 backend-served but not UI-integrated** (`healthz`, `health`) = **15** of the
> backend's **15** routes (a 1:1 match — every backend route now has a generated
> client operation; the ZIP upload endpoint is fully wired).

---

## 3. Backend (`backend/`)

### Entry & middleware (`backend/src/index.ts`, `app.ts`)
- Listens on `PORT` (default **8000**); validates the port (NaN/≤0 → throw).
- Startup logs safe environment diagnostics (key presence + length only, never the value).
- Middleware order: pino-http → CORS allowlist → `express.raw`
  (`application/zip`, `application/octet-stream`, `multipart/form-data`, 30 mb)
  → `express.json()` → `express.urlencoded()`.

### API routes (`backend/src/routes/`)

| # | Method | Path | Purpose / handler | Request | Response | Frontend consumer |
| - | ------ | ---- | ----------------- | ------- | -------- | ----------------- |
| 1 | GET | `/api/healthz` | liveness + `xai_configured` flag (`routes/health.ts`) | — | `{status:"ok", xai_configured:boolean}` | **none** |
| 2 | GET | `/api/health` | alias of healthz | — | same | **none** |
| 3 | GET | `/api/dashboard` | counts + last 8 migrations + hard-coded capabilities (`routes/agent.ts`) | — | dashboard summary | Dashboard |
| 4 | POST | `/api/repositories/upload` | ZIP upload → **secure validate before extract** → workspace → analyze → persist (`readUploadedZip` + `extractZipToWorkspace` + `analyzeRepository`). Returns machine-readable errors (`INVALID_FILE_TYPE`, `FILE_TOO_LARGE`, `INVALID_ZIP`, `ZIP_PATH_TRAVERSAL`, `ZIP_SIZE_LIMIT`, `EXTRACTION_FAILED`); oversize body → 413 `FILE_TOO_LARGE`. | multipart `file` (`.zip`) | public repository (201) | NewMigration (ZIP tab) |
| 5 | POST | `/api/repositories/github` | GitHub URL → metadata → codeload ZIP → analyze → persist. 400 on failure. | `{url}` | public repository (201) | NewMigration |
| 6 | GET | `/api/repositories/{id}` | repository detail; 404 if missing | — | public repository | NewMigration |
| 7 | GET | `/api/migrations` | all migrations, public shape | — | `Migration[]` | Dashboard |
| 8 | POST | `/api/migrations` | create + start migration. Validates `repositoryId`, `dependency`, `targetMajor` (digits); 202; 400 on invalid. | `{repositoryId,dependency,targetMajor,mode}` | public migration (202) | NewMigration |
| 9 | GET | `/api/migrations/{id}` | migration job state; 404 if missing | — | public migration | Workspace/Frame |
| 10 | GET | `/api/migrations/{id}/events` | event log for a migration | — | `MigrationEvent[]` | Workspace |
| 11 | GET | `/api/migrations/{id}/diff` | captured diff; 404 if missing | — | diff object | DiffPage |
| 12 | GET | `/api/migrations/{id}/report` | **assembled** report (see below) | — | report object | ReportPage |
| 13 | POST | `/api/migrations/{id}/approve` | approve **only if `status==="completed"`** else 409; sets `approved` + event | — | public migration | ReportPage |
| 14 | POST | `/api/migrations/{id}/reject` | reject **only if `status==="completed"`** else 409; sets `rejected` + event | — | public migration | ReportPage |
| 15 | POST | `/api/migrations/{id}/cancel` | cancel any migration (sets `cancelled` + flag + event); **no running-state guard** | — | public migration | Workspace |

```
Total backend API endpoints:    15
Actually consumed by frontend:  13   (ZIP upload now wired)
Served but not UI-integrated:   2   (healthz, health aliases — static topbar pulse)
```

> **OpenAPI parity:** the spec now defines **16 paths** — it was updated to add
> `/api/health` (alias, `healthCheckAlias`), `/api/migrations/{id}/reject`
> (`rejectMigration`), `format: binary` on the upload `file` field, the
> `Migration` `attempts`/`verificationCommands`/`baseline`/`cancelled` fields, the
> `MigrationReport` `plan`/`verificationCommands`/`baseline`/`approvalStatus`
> fields, and the `MigrationPlan`/`VerificationCommand`/`BaselineResult` schemas.
> Both orval clients (`api-client-react`, `api-zod`) were **regenerated** from it
> (orval 8.27). The react client types `RepositoryUploadInput.file` as `Blob`.

### Public shape sanitization (`routes/agent.ts`)
- `publicMigration` strips internal fields and **never returns** `plan`,
  `impactFiles`, `sources`, `changes`, `remainingIssues`, `diff` on the list/get
  responses; it **does** include `agentState`, `research`, `riskSummary`,
  `attempts`, `verificationCommands`, `baseline`, `cancelled`. Diff/report are
  fetched via their own endpoints.
- `publicRepository` strips `rootPath`.

### The report endpoint (`GET /migrations/{id}/report`)
Assembles and returns `{ migrationId, status, summary (from plan), repository,
impact, sources, changes, attempts, remainingIssues, research, riskSummary,
plan, affectedApiFindings, verificationCommands, baseline, approvalStatus }`.

---

## 4. Agent architecture (the real implementation)

There is **no LangGraph graph**. The migration is a **sequential pipeline in
`backend/src/lib/repository-agent.ts` (`runMigration`)** with a **multi-round
tool-calling coding-agent loop** (`agents/coding-agent.ts`) and a **bounded
self-healing retry loop**. There is no node/edge graph object — stages are
progress markers (`currentStage`).

### 4.1 Pipeline stages (`runMigration`)

```
queued
 ↓
research            — fetch real docs (npm metadata + repo guides) → MigrationResearch
synthesis           — Grok (or honest fallback) derives structured findings
impact-analysis     — scanRepositoryUsage() + applyRiskToFindings() → riskSummary
migration           — git baseline commit → dependency install (or manifest-edit fallback)
                      → runCodingAgent() applies targeted patches via tools
verify              — repo scripts test/build/typecheck/lint → per-command records
heal (agentic only) — diagnose() + repair pass + re-verify, bounded ≤ 3 attempts
complete / failed / cancelled
```

### 4.2 Node/stage responsibilities

| Stage | What it does | Inputs | Produces | Services/tools | Success → | Failure → |
|-------|--------------|--------|----------|----------------|-----------|-----------|
| **Research** | `researchDependency(dep, currentMajor, targetMajor)` — fetch npm metadata, then UPGRADING/MIGRATION/CHANGELOG/docs URLs discovered from it. 15 s timeouts, up to 8 sources. | dependency, current & target major | `MigrationResearch` (sources, confidence) | HTTP fetch, `lib/research.ts` | records retrieved sources | pushes `RESEARCH_FAILED` issue, confident="none", continues |
| **Synthesis** | `synthesizeFindings(provider,…)` asks Grok for a structured, evidence-based JSON summary from ONLY retrieved sources + repo facts. **No Grok / no key → `fallbackFindingsFromSources()` (honest, never invented, confidence ≤ low).** | retrieved sources + repo context | `MigrationFindings` (categories, findings, confidence) | Grok (`lib/synthesis.ts`) | merge into research | degraded fallback + `RESEARCH_SYNTHESIS_FAILED` issue |
| **Impact analysis** | `scanRepositoryUsage()` — regex+state-machine scanner skipping comments/strings; classifies IMPORT/REQUIRE/API_USAGE/CONFIGURATION/PACKAGE_MANIFEST/TEST_USAGE with real lines. Then `applyRiskToFindings()` correlates research tokens (removed/renamed/changed APIs) → high/medium/low. | repo, dependency | `riskSummary` (files, usages, high/med/low, affected APIs) | `lib/impact.ts`, `lib/risk.ts` | sets affectedFiles/usages + risk summary | non-fatal (empty findings) |
| **Git baseline** | `git init`, config, `.agent-gitignore` (excludes `.agent-backups`, node_modules, dist, build), `add -A`, baseline commit. | workspace | real baseline for diffs | `git` via `runCommand` | — | `UNSUPPORTED_PACKAGE_MANAGER` if not npm/pnpm → job fails |
| **Install** | **Phase 2 REAL**: `npm install <dep>@<target>` or `pnpm add <dep>@<target>`. Validates dependency exists, validates target version, snapshots lockfile BEFORE, runs real package manager, validates lockfile AFTER, verifies installed version matches target. **On any failure**: throws structured error (DEPENDENCY_INSTALL_FAILURE, DEPENDENCY_VERSION_MISMATCH, etc.) and stops. NO fallback to manifest edit. | manifest | updated dependency + verified version + updated lockfile | npm/pnpm subprocess, `lib/dependency-validation.ts`, `lib/install-verification.ts` | records change + verified version | throws error, stops migration; error recorded in remainingIssues |
| **Coding agent** (see 4.3) | Multi-round tool loop applying real file edits. | research/impact/risk summaries | `agentState` (tool calls, files, patches), optional structured `plan` | 10 validated tools + Grok | patches applied | non-fatal: records issue, continues to verification so a diff still exists |
| **Verify** | `verifyMigration()` runs `test`/`build`/`typecheck`/`lint` present in package scripts via the manager (120 s each). Each → PASS/FAIL/SKIPPED/TIMEOUT with stdout/stderr/duration. TIMEOUT treated as fail. | repo scripts | `verificationCommands`, tests/build/typecheck/lint, `remainingIssues`, failed[] | manager subprocess, `lib/run-command.ts` | all pass | failed list captured |
| **Heal** *(agentic only)* | While not passed and attempt < **3**: `diagnoseFailure()` (Grok: concise JSON diagnosis) → run **repair pass** of the coding agent with `failureContext` → re-verify → re-diff → record attempt. | failed commands + research + plan + impact + files | attempt records (`{number,result,diagnosis,filesChanged,filesModified, patch}`) | `lib/heal.ts`, coding agent, verify | PASS recorded | stops after attempt 3 → status `failed`, errorCode `VERIFICATION_FAILURE`, "could not be automatically repaired after 3 attempts" |
| **Finalize** | Sets status completed/failed/cancelled + agentState status; final event. | — | terminal record | — | — | — |

### 4.3 Coding-agent tool loop (`agents/coding-agent.ts`)

A **while-loop of up to 25 tool rounds**, no fixed graph:

```
system prompt (research/impact/risk context) + user intro
 ↓
provider.chat(messages, toolDefinitions)
 ├─ model returns tool calls → execute each via executeTool() with validated
 │    workspace path + scheme → append `tool` results → loop again
 └─ model returns final JSON (no tool calls) → parse summary / no_changes_required → done
```

- Provider: `GrokProvider` (live `XaiGrokProvider` when `XAI_API_KEY` set, or an
  injected scripted provider in tests, or **null** when unconfigured).
- Every tool outcome is boxed into `{ok:true,result}` or
  `{ok:false,errorType,message,path}` so the model can recover.
- The loop persists `agentState` after every tool call (`currentAction`, tool
  calls with timestamp/input/result/duration/success, files inspected/modified,
  patches applied).
- **No chain-of-thought is ever surfaced** — only tool inputs/outputs and a final
  JSON summary. The final message must be valid JSON
  `{"summary": "...", "no_changes_required": bool}`.
- `create_migration_plan` captures a structured `AgentPlan` (breaking changes,
  planned changes, verification commands, affected APIs, risk, package/source/
  config changes, potential failure points, research confidence).

### 4.4 The 10 tools (`agents/tools/`)

| Tool | Purpose | Guardrails |
| ---- | ------- | ---------- |
| `list_files` | bounded directory listing | max 400 entries, depth ≤4, skips node_modules/.git/dist/build/.data |
| `read_file` | read file content | workspace-only path, ≤256 KB, rejects directories |
| `search_code` | regex search w/ line numbers | ≤100 matches, ≤2000 files, skip noise dirs |
| `read_package_json` | manifest read | workspace-only |
| `read_config` | read known config files only | allow-list (tsconfig, vite/next/eslint/babel/jest/vitest/prettier, lockfiles) |
| `create_migration_plan` | structured plan capture | must include dep/from/to/planned/verification |
| `write_file` | create NEW files only | refuses overwrite, ≤512 KB, workspace-only |
| `apply_patch` | unified-diff to existing files | hunks only (no headers), git apply validated, ≤512 KB, backups under `.agent-backups/` |
| `run_command` | run allowed commands in workspace | allow-list: npm/pnpm/yarn/node/npx/tsc/git (git push/clone/remote blocked), ≤24 args, 120 s timeout, cwd traversal rejected |
| `get_git_diff` | real working-tree diff vs baseline | reads git state; never invented |

All paths go through `resolveInWorkspace()` which rejects absolute POSIX/Windows
paths and `..` traversal, then asserts the normalized path stays inside the root
(defense in depth). Every failure is a structured `ToolError`.

### 4.5 Mode behavior
- **agentic**: research → impact → agent → verify → **self-healing repair loop**.
- **baseline**: research → impact → simple dependency update → verify (recorded in
  `migration.baseline`) → **no diagnosis/repair** (`while (mode !== "baseline" …)`).

> ⚠️ Both modes require Grok for the **coding agent** step. Without `XAI_API_KEY`,
> `runCodingAgent` throws `GROK_NOT_CONFIGURED` (caught, recorded as an issue) and
> the run continues to verification against the manifest-only change. Research
> synergy is still honest without a key (fallback synthesis).

---

## 5. Services (backend)

| Service | File | Responsibility |
| ------- | ---- | -------------- |
| `repository-agent.ts` | `lib/` | Orchestrates the whole pipeline; `analyzeRepository`, `createRepositoryWorkspace`, `importGithubWorkspace`, `startMigration`, `runMigration`, `verifyMigration`. |
| `dependency-validation.ts` | `lib/` | **Phase 2**: Validates dependency name, target version format, package manager support. Structured error codes. |
| `install-verification.ts` | `lib/` | **Phase 2**: Snapshots lockfiles, detects changes, verifies installed version, basic semver matching. |
| `migration-state.ts` | `lib/` | JSON-file persistence; typed records; serialized atomic writes. |
| `research.ts` | `lib/` | Real documentation retrieval (npm + guides) with timeouts and honest unavailable sources. |
| `research-types.ts` | `lib/` | Shared `MigrationResearch` / `ResearchSource` / finding types. |
| `impact.ts` | `lib/` | Comment/string-aware usage scanner producing `ImpactFinding[]`. |
| `risk.ts` | `lib/` | Research↔usage correlation → per-finding risk levels + `ImpactSummary`. |
| `synthesis.ts` | `lib/` | Grok structured synthesis + deterministic fallback. |
| `heal.ts` | `lib/` | Failure diagnosis (Grok JSON summary), `MAX_HEAL_ATTEMPTS = 3`. |
| `git.ts` | `lib/` | `captureDiff()` → real diff summary (files/additions/deletions). |
| `run-command.ts` | `lib/` | Controlled subprocess runner: timeout (120 s), output cap, safe env, Windows `.cmd` shim handling. |
| `workspace.ts` | `lib/` | Temp workspace root, extraction engines (unzip→tar→PowerShell), directory copy. |
| `zip.ts` | `lib/` | Secure ZIP ingestion: pure-Node central-directory parse + validate-before-extract + cleanup (`extractZipToWorkspace`). |
| `zip-config.ts` | `lib/` | Configurable ZIP limits (env-driven). |
| `logger.ts` | `lib/` | pino logger w/ secret redaction. |
| `coding-agent.ts` | `agents/` | Tool-calling loop; `runCodingAgent`. |
| `agent-plan.ts` / `agent-state.ts` | `agents/` | Structured plan + public agent state types. |
| `services/ai/*` | `services/` | `GrokProvider` interface, `XaiGrokProvider` (chat/tool calling), lazy `getGrokProvider()`, config/API errors. |

---

## 6. Complete user flow (as implemented)

```
Dashboard (/)
   │  "Start a migration" ·  recent-migration rows
   ▼
New Migration (/new)  — source tabs: GitHub URL | Upload ZIP
   │  GitHub tab → Analyze repository (POST /repositories/github)
   │       ─ analysis errors → "Repository analysis failed" + Retry
   │  ZIP tab     → drag/drop or browse .zip (client validates type+size)
   │       ─ POST /repositories/upload → secure validate + extract + analyze
   │       ─ upload/error/success states; remove/reselect available
   │       ─ errors: INVALID_FILE_TYPE / FILE_TOO_LARGE / INVALID_ZIP /
   │                  ZIP_PATH_TRAVERSAL / ZIP_SIZE_LIMIT / EXTRACTION_FAILED
   ▼
RepositoryDetails: pick dependency (actual deps) → target major → mode (agentic|baseline)
   │  Start migration (POST /migrations) → navigate to /migration/:id
   ▼
Workspace (/migration/:id)  — polls 4.5 s
   ├─ StageTrack: Intake → Research → Impact map → Apply → Verify
   ├─ Event log, Agent activity, Impact stats, Verification, Artifacts
   ├─ ResearchSection + ImpactMap + Attempts + Verification commands + Baseline
   └─ Cancel (while running/queued)
        │
        ⤷ backend runMigration():
           research (docs) → synthesis (Grok|fallback) → impact+risk →
           git baseline → install (or manifest fallback) → coding agent (patches) →
           verify (test/build/typecheck/lint) →
           [agentic] failed? → diagnose → repair pass → re-verify (≤3 attempts)
   ▼
Actual Diff (/migration/:id/diff)     — git diff vs baseline, colored per file
   ▼
Final Report (/migration/:id/report)  — summary, changes, sources, research, impact,
                                      attempts, verification, baseline, remaining issues
   ▼
Approval gate
   ├─ Approve (POST approve; requires completed) → status approved
   └─ Reject  (POST reject;  requires completed) → status rejected
```

**Fully implemented:** GitHub import · analysis · dependency/version/mode selection ·
research · synthesis · impact/risk · git baseline · install(+fallback) · coding agent ·
verify · self-healing (agentic) · diff · report · approve/reject · cancel · polling liveness.

**Not implemented:** GitHub PR push · SSE/WebSocket · resume/queue · full state machine graph.

---

## 7. Feature matrix

| Feature | Status | Frontend | Backend | AI/Agent | Notes |
| ------- | ------ | -------- | ------- | -------- | ----- |
| Dashboard summary | ✅ | yes | `GET /dashboard` | — | counts + recent |
| GitHub import | ✅ | `/new` (URL) | `POST /repositories/github` | — | REST + codeload ZIP |
| ZIP upload | ✅ | ZIP tab, drag-drop, states | `POST /repositories/upload` (secure) | — | client-side validation + secure extract |
| ZIP extraction | ✅ | — | `lib/zip.ts` + `lib/workspace.ts` | — | pure-Node central-dir parse + unzip/tar/PowerShell extract |
| ZIP security | ✅ | client size/ext-type check | `lib/zip.ts` validate-before-extract | — | traversal/absolute/size/entry/cleanup guards |
| Repository root detection | ✅ | — | `findPackageRoot` (bounded depth) | — | flat + nested; scores by dep-count |
| Repository analysis | ✅ | repo card | `analyzeRepository` | — | package.json, language, framework, scripts |
| Package-manager detection | ✅ | — | `analyzeRepository` + validated in `startMigration` | — | npm/pnpm only; yarn/unsupported rejected before queue |
| Dependency detection | ✅ | picker | all 4 manifest sections + validated | — | rejects before queue if not found |
| Dependency validation | ✅ | — | `lib/dependency-validation.ts` (Phase 2) | — | validates name, target version, package manager |
| Version selection | ✅ | target major input | normalized + validated (^X.Y.Z) | — | supports 19, 19.x, ^19.0.0, ~19.0.0, 19.0.0, latest |
| Migration research | ✅ | panel | `lib/research.ts` | docs fetch | real URLs, honest unavailable |
| Research synthesis | ✅ / degraded | panel | `lib/synthesis.ts` | Grok or fallback | fallback ≤ low confidence |
| Impact analysis | ✅ | Impact map | `lib/impact.ts` | — | comment/string-aware regex |
| Risk correlation | ✅ | risk chips | `lib/risk.ts` | research-based | only at-risk APIs → high |
| Migration planning | ✅ | report/plan | `agents/tools/create-migration-plan.ts` | Grok tool call | structured `AgentPlan` |
| Grok integration | ✅ (key-gated) | — | `services/ai/grok.ts` | chat + tool calls | `XAI_API_KEY` |
| Code modification | ✅ | — | `coding-agent.ts` + apply_patch/write_file | Grok tool loop | real git-applied edits |
| Dependency install | ✅ (Phase 2) | — | real npm/pnpm subprocess | — | validates dependency, target, lockfile, installed version |
| Lockfile validation | ✅ (Phase 2) | — | `lib/install-verification.ts` snapshots + compares | — | detects package-lock.json or pnpm-lock.yaml changes |
| Version verification | ✅ (Phase 2) | — | `lib/install-verification.ts` reads node_modules or list | — | validates installed version matches target semver |
| Install failure handling | ✅ (Phase 2) | — | throws DEPENDENCY_INSTALL_FAILURE on error | — | no silent fallback; explicit error + stop |
| Version mismatch detection | ✅ (Phase 2) | — | throws DEPENDENCY_VERSION_MISMATCH | — | stops migration if installed ≠ target |
| Tests | ✅ | — | verify script `test` | — | PASS/FAIL/SKIPPED/TIMEOUT |
| Build | ✅ | — | `build` | — | same |
| Typecheck | ✅ | — | `typecheck` | — | same |
| Lint | ✅ | — | `lint` | — | same |
| Failure diagnosis | ✅ (agentic) | attempts card | `lib/heal.ts` | Grok | concise JSON diagnosis |
| Self-healing | ✅ (agentic) | patch timeline | repair pass loop | Grok + tools | ≤3 attempts |
| Retry limit | ✅ | — | `MAX_HEAL_ATTEMPTS=3` | — | bounded, never infinite |
| Diff generation | ✅ | diff page | `captureDiff()` | — | real git diff + numstat |
| Final report | ✅ | report page | `GET /report` | — | assembles everything |
| Live events/logs | ✅ | event log | `addEvent` / `getEvents` | — | polling, not SSE |
| Persistence | ✅ | — | JSON file | — | atomic serialized writes |
| Approval | ✅ | Approve btn | `POST approve` (guarded) | — | completed → approved |
| Rejection | ✅ | Reject btn | `POST reject` (guarded) | — | completed → rejected |
| Baseline mode | ✅ | baseline card | `migration.baseline` | — | no repair loop |
| GitHub PR | ❌ | — | — | — | explicitly not implemented |
| Security controls | ✅ | — | tools + workspace + validation | — | see §9 |
| Temp workspace | ✅ | — | `<temp>/dependency-agent/<uuid>/` | — | isolated per job |
| Command execution | ✅ | — | `runCommand` | — | allow-list, timeout, cap |
| Tests (repo) | ✅ | — | `backend/tests/*.test.ts` (node:test) | mocked Grok | 11 suites, 92 cases (Phase 2 +20 validation, +10 install E2E)

---

## 8. AI / Grok integration

- **Provider**: xAI **Grok** chat completions, `https://api.x.ai/v1/chat/completions`.
- **Model**: `XAI_MODEL` env or default `grok-4-latest`; `temperature: 0`.
- **Auth**: `Authorization: Bearer ${XAI_API_KEY}` — read from the **process env
  only**, never sent to the model, never logged (startup logs presence+length; pino
  redacts headers). A real key does appear in `backend/.env` (not reproduced here).
- **Where it's called**:
  1. **Research synthesis** (`lib/synthesis.ts`) — structured findings JSON.
  2. **Coding/repair agent** (`agents/coding-agent.ts`) — function/tool calling loop.
  3. **Failure diagnosis** (`lib/heal.ts`) — concise root-cause JSON.
- **Tool/function calling**: the provider maps tools to OpenAI-style
  `tools: [{type:"function", function:{name, description, parameters}}]` and
  returns parsed `tool_calls` (`grok.ts`).
- **Missing key behavior**:
  - `getGrokProvider()` throws `GROK_NOT_CONFIGURED` (no fake responses).
  - In `runMigration`, the coding-agent call is guarded (`provider = __migAgentProvider
    ?? getGrokProvider()`) so the agent step fails non-fatally **when no key** (the
    run continues to verification of the manifest-only change).
  - Research **synthesis** degrades to an honest deterministic fallback.
  - Health endpoint exposes only `xai_configured: boolean`.
- **Failure handling**: `GrokApiError` (HTTP), `GrokConfigError` (unset key), and
  JSON-parse errors are caught and surfaced as issues/events; diagnosis/providers
  never silently succeed.
- **No chain-of-thought** in any persisted/shown field: only tool activity and
  structured summaries.

Encryption/secret policy: no secrets are stored or transmitted beyond the required
`XAI_API_KEY` / `GITHUB_TOKEN` env vars (the latter is optional, sent as a bearer
header only to api.github.com).

---

## 9. Data / state flow

```
Frontend (React Query hooks, polling)
      │  HTTP JSON
      ▼
Express routes (agent.ts / health.ts)
      │  reads/writes
      ▼
migration-state.ts  ──▶  backend/.data/migration-state.json
      │                    { repositories[], migrations[], events[] }
      ▼
repository-agent.ts ──▶  <temp>/dependency-agent/<uuid>/
      │                    repository.zip · original/ · workspace/
      ▼
tools (apply_patch/write_file/run_command) → git baseline + working tree
      ▼
verifyMigration → verificationCommands[] + tests/build/typecheck/lint
      ▼
captureDiff() → diff {filesChanged, additions, deletions, files[]}
      ▼
report endpoint assembles summary/research/risk/attempts/commands/baseline
      ▼
Frontend renders workspace → diff → report → approval
```

### Persistence details (`lib/migration-state.ts`)
- **No database** — one JSON file: `{ repositories: [], migrations: [], events: [] }`.
- Writes serialized through a promise `writeQueue`; atomic (temp file + rename);
  state re-loaded on write failure; events capped at last **5000**.
- Type-rich `MigrationRecord` carries Phase 2 fields: `research`,
  `riskSummary`, `verificationCommands`, `attempts`, `baseline`, `cancelled`,
  `agentState` (with last tool calls), plus legacy `plan`, `impactFiles`, `sources`,
  `changes`, `remainingIssues`, `diff`, `errorCode`.
- The data dir is anchored by walking up until `package.json` with `name:
  "@dua/backend"`, so `src/` and bundled `dist/` share the same state file.
- **In-memory + fire-and-forget**: jobs stop with the process (no queue/resume).

---

## 10. Security (verified)

| Control | Where | Status |
| ------- | ----- | ------ |
| Isolated temp workspace | `lib/zip.ts` + `workspace.ts` → `<temp>/dependency-agent/<uuid>/` | ✅ per job, never app source tree |
| ZIP central-directory parse | `lib/zip.ts` `parseZipEntries()` — pure Node, reads names + uncompressed sizes BEFORE extract | ✅ no trust in OS listing |
| ZIP traversal protection | rejects any absolute path (POSIX/Windows drive/UNC), `..` segments, overlength paths | ✅ before extract |
| ZIP entry-count limit | `maxEntries` (default 20 000) via `validateZipEntries()` | ✅ |
| ZIP per-entry size limit | `maxEntryBytes` (default 50 MB) via `validateZipEntries()` | ✅ |
| ZIP total-uncompressed limit | `maxTotalUncompressedBytes` (default 250 MB) | ✅ (bomb defense) |
| ZIP upload-size limit | `maxUploadBytes` (default 30 MB) + `express.raw` 30 mb body cap | ✅ (`FILE_TOO_LARGE` / 413) |
| Extraction-result boundary | `assertExtractedTree()` verifies every extracted path stays inside root + rejects symlinks | ✅ defense in depth |
| Failed-extraction cleanup | `extractZipToWorkspace()` removes the whole job workspace on any failure | ✅ no partial workspace leaks |
| Configurable limits | `lib/zip-config.ts` via `DUA_MAX_UPLOAD_BYTES`, `DUA_MAX_ZIP_ENTRIES`, `DUA_MAX_ZIP_TOTAL_BYTES`, `DUA_MAX_ZIP_ENTRY_BYTES`, `DUA_MAX_ZIP_PATH_DEPTH` | ✅ env-driven |
| Tool workspace-boundary check | `resolveInWorkspace()` rejects absolute POSIX/Windows paths + `..`, then asserts normalized path stays in root | ✅ defense in depth |
| Config allow-list | `read_config` only known config basenames | ✅ |
| Command allow-list | `run_command` only npm/pnpm/yarn/node/npx/tsc/git; push/clone/remote blocked; ≤24 args | ✅ |
| Subprocess timeout | `run-command.ts` 120 s default, SIGKILL, exit code 124 | ✅ |
| Output limits | `run-command` 24 KB cap (stdout+stderr), per-script verify capped, patch caps 512 KB, read 256 KB | ✅ |
| Agent round limit | `MAX_TOOL_ROUNDS = 25` | ✅ |
| Retry limit | `MAX_HEAL_ATTEMPTS = 3` | ✅ |
| Secret handling | keys only in process env; never sent to model; pino redacts auth/cookie | ✅ |
| GitHub token | optional `GITHUB_TOKEN` bearer only to api.github.com / codeload | ✅ |
| Uploaded-repo isolation | `original/` read-only before-state; git ignores agent backups; never touches user workspace | ✅ |
| CORS | explicit allowlist, defaults to Vite origin | ✅ |
| Cancel safety | cancel route: **no running-state guard** | ⚠️ backend would cancel a non-running job (UI only offers it when running/queued) |

**Known gaps:** `yarn` is detected as `unsupported` (migration fails with
`UNSUPPORTED_PACKAGE_MANAGER`); GitHub import needs `unzip`/`tar`/PowerShell
present (the pure-Node validator still catches traversal/limits, so extraction
tool absence blocks only the extract step); the state file holds everything in
plaintext (workspaces contain no new secrets, but original repos could). The
ZIP size limits are configurable but default to values that assume a normal
JS/TS monorepo — an unusually large real repo may be rejected.

---

## 11. Project structure (meaningful files)

```
project/
├── package.json                 # npm workspaces + root scripts (dev/build/typecheck/test)
├── pnpm-workspace.yaml
├── .env.example                 # env var documentation (no real secrets)
├── PROJECT_FLOW.md              # this file
├── docs/                        # ARCHITECTURE, EVALUATION, AGENT_TRAJECTORIES, etc.
│
├── frontend/
│   ├── index.html               # favicon = /logo.png (favicon updated)
│   ├── vite.config.ts           # @-alias, /api proxy, build out dist/public
│   ├── public/
│   │   ├── logo.png             # app logo + favicon + sidebar brand
│   │   └── favicon.svg          # (no longer referenced; kept)
│   └── src/
│       ├── main.tsx             # createRoot + ErrorBoundary
│       ├── App.tsx              # ALL pages, Shell, nav, agent UI (single file)
│       ├── App.css / index.css  # theme + hand-written classes (+ collapsible sidebar CSS)
│       ├── api/client.ts        # VITE_API_URL → setBaseUrl
│       ├── pages/not-found.tsx
│       ├── components/
│       │   ├── error-boundary.tsx
│       │   └── ui/…             # ~50 shadcn primitives (mostly unused)
│       └── hooks/               # use-mobile, use-toast (unused-toast)
│
├── backend/
│   ├── build.mjs                # esbuild bundle → dist/
│   ├── .env                     # local env (PORT/FRONTEND_ORIGIN/XAI_API_KEY/…)
│   ├── .data/migration-state.json
│   ├── src/
│   │   ├── index.ts, app.ts     # server + middleware + CORS
│   │   ├── routes/
│   │   │   ├── index.ts, health.ts, agent.ts
│   │   ├── lib/
│   │   │   ├── repository-agent.ts   # pipeline orchestrator
│   │   │   ├── migration-state.ts    # JSON persistence
│   │   │   ├── research.ts / research-types.ts
│   │   │   ├── impact.ts / risk.ts / synthesis.ts / heal.ts
│   │   │   ├── git.ts / run-command.ts / workspace.ts / zip.ts / zip-config.ts / logger.ts
│   │   ├── agents/
│   │   │   ├── coding-agent.ts
│   │   │   ├── agent-plan.ts / agent-state.ts
│   │   │   └── tools/                # 10 tools + path guard + context + factory
│   │   └── services/ai/
│   │       ├── types.ts / provider.ts / grok.ts / index.ts
│   └── tests/
│       ├── e2e.test.ts, heal-e2e.test.ts, phase2.test.ts
│       ├── coding-agent.test.ts, heal.test.ts, state.test.ts
│       ├── zip-security.test.ts, zip-api.test.ts / zip-maker.ts (helper)
│       ├── tools.test.ts, tool-security.test.ts
│       └── scripted-*-provider.ts / helpers.ts   # mocked Grok for tests
│
└── shared/
    ├── api-spec/
    │   ├── openapi.yaml         # ⚠️ lags backend (missing /health, /reject, Phase 2 fields)
    │   ├── orval.config.ts
    ├── api-client-react/        # generated React hooks client (used)
    └── api-zod/                 # generated zod schemas (backend health; partial)
```

### Tests (backend, `node --test` via tsx)
11 suites → **65 cases**, all dependency-injected Grok (scripted providers) except
the research test which does a real fetch to npm:
`e2e` (real zip→analysis→migration→file change→diff), `heal-e2e`
(genuine failing build repaired ≤3 attempts → PASS), **`zip-security`** (valid
extract, nested/flat root, invalid zip, traversal; absolute/POSIX/Windows paths,
entry-count, per-entry + total size limits, oversized upload, cleanup after
failure, analysis: package.json/npm/pnpm/deps/scripts), **`zip-api`** (live-E2E
mulipart upload through the real app: success, nested root, invalid, empty,
traversal, oversized, no-package.json, missing-dependency rejection,
full intake flow), `phase2` (research/impact/risk/synthesis), `coding-agent`,
`heal`, `state`, `tools`, `tool-security`.

> The backend test script runs **serially** (`--test-concurrency=1`) because the
> shared JSON state file races across concurrent processes on Windows.
> Root `npm test` is still `echo "No project test suites …"` — run
> `npm --prefix backend test` for the suites above.

---

## 12. Current status

```
Frontend pages/routes:        6  (Dashboard, NewMigration, Workspace, Diff, Report + 404)
Frontend API integrations:    13 (distinct endpoints actively called, incl. ZIP upload)
Backend API endpoints:        15 (13 consumed · 2 served-but-unused-in-UI health aliases)
Agent nodes/stages:           8 pipeline stages + a 25-round tool-calling loop + ≤3 heal attempts
Major implemented features:   ~31 (matrix in §7, incl. ZIP upload + security)
Tests:                        11 node:test suites (65 cases)
```

### Fully implemented (end-to-end, verified from code)
- GitHub-repo import + analysis (language, package manager, deps, framework, scripts).
- Structured **research pipeline**: real npm-metadata + guide/documentation
  retrieval with honest "unavailable" sources, Grok synthesis with deterministic fallback.
- Repository-aware **impact analysis** + research-correlated **risk**.
- Git-baselined, real diff capture.
- Dependency install (npm/pnpm) with manifest-edit fallback.
- **Coding agent**: tool-calling loop over 10 validated tools that edits real files, records `agentState`, produces a structured plan.
- Verification of test/build/typecheck/lint with rich per-command records.
- **Self-healing** (agentic): failure diagnosis + corrective repair, bounded to 3 attempts.
- Diff page, final report, **approve/reject** (guarded to `completed`), cancel.
- JSON persistence, atomic writes, events capped at 5000.
- Collapsible sidebar + logo + favicon (recent UI work).
- Backend test suites proving the e2e + heal + Phase 2 loops.

### Partially implemented
- **Agentic vs baseline**: both run the coding agent only if Grok is keyed;
  agentic additionally self-heals, baseline records a `baseline` snapshot only.
- **Grok**: full chat + tool calling, but gated entirely behind `XAI_API_KEY`;
  no retries on provider errors (degradation is catch+record).
- **Research confidence**: honest fallback caps at "low" when no key/guide.
- **Yarn/lockfile npm edge cases**: `yarn.lock` → `packageManager: "unsupported"`.

### Defined but unused today
- `GET /api/healthz` + `GET /api/health` and the `useHealthCheck`/`useHealthCheckAlias`
  hooks (topbar "API connected" is a static pulse; never fetches).
- `listRepositories()` / `getRepository` legacy helpers beyond `/repositories/{id}`.
- Most `frontend/src/components/ui/*` shadcn components; `use-toast`, `sonner`, etc.
- `listZipEntries`' `tar` / `powershell` paths (used only when `unzip` absent).

### Missing / not implemented
- GitHub **PR / push** integration (explicitly out of scope; isolated workspace → diff only).
- SSE / WebSocket streaming (UI simulates liveness with polling).
- Durable job queue / resume after restart (in-memory fire-and-forget).
- Auth / multi-user / repository list & delete pages.
- Frontend test suites (`frontend/tests` does not exist).
- Decompressed-total-size defense is present; HTML/symlink edge extraction still
  relies on `assertExtractedTree` which rejects symlinks.

### Known issues (from code)
1. **Cancel has no running-state guard** on the server; the UI only offers it
   while running/queued, but the API will cancel any state.
2. **Migration cannot use the coding agent without `XAI_API_KEY`** — it records
   `GROK_NOT_CONFIGURED` and continues to verification with only the manifest
   change (honest, but the agent-driven path is unreachable without the key).
3. **Yarn repos fail** (`unsupported` manager → `UNSUPPORTED_PACKAGE_MANAGER`) and
   all four checks become `skipped`.
4. Backend tests must run **serially** (`--test-concurrency=1`): on Windows the
   shared JSON state file's atomic rename races across concurrent test processes,
   causing flaky `EPERM`/`ENOENT` rename failures. Serial execution is committed
   in `backend/package.json`.
5. **`express.raw` manual multipart parsing** is brittle for non-multipart clients
   (falls back to whole-body-as-zip). The supported contract is multipart
   `FormData` with a `file` field — the frontend and API tests both use it.
6. The "API connected" indicator is decorative (no health call from the UI).
```