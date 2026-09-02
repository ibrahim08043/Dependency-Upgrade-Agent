# Architecture

## System Overview

```text
                    ┌──────────────────────┐
                    │      Frontend        │
                    │ Developer Command    │
                    │ Center / Workspace   │
                    └──────────┬───────────┘
                               │ HTTP/SSE/Polling
                               ▼
                    ┌──────────────────────┐
                    │      FastAPI         │
                    │ REST API + Jobs      │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │      LangGraph       │
                    │ Migration Workflow   │
                    └──────────┬───────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
 Repository Analyzer    Research / Grok       Verification
        │                      │                      │
        ▼                      ▼                      ▼
 Impact Analysis        Migration Planning      Tests/Build/
        │                 & Diagnosis            Typecheck/Lint
        └──────────────────────┼──────────────────────┘
                               ▼
                    Self-Healing / Retry
                               │
                               ▼
                    Actual Diff + Report
```

## Core Flow

```text
Repository
→ Analyze
→ Research
→ Impact Analysis
→ Plan
→ Modify isolated workspace
→ Verify
→ Diagnose failures
→ Corrective patch
→ Retry
→ Final verification
→ Diff
→ Report
→ Human approval
```

## Frontend

Primary responsibilities:

- Repository intake
- Dependency selection
- Migration workspace
- Live events/logs
- Migration plan display
- Impact display
- Verification status
- Diff viewer
- Final report
- Approval/rejection

## Backend

Primary responsibilities:

- Repository ingestion
- Safe ZIP extraction
- GitHub repository access
- Repository analysis
- Agent orchestration
- Grok integration
- Controlled tool execution
- Verification
- Job persistence
- Events
- Diff generation
- Reports

## Agent Tools

Controlled tools include:

- list_files
- read_file
- search_code
- read_package_json
- read_lockfile
- write_file
- apply_patch
- run_command
- get_git_diff
- get_file_metadata

All tools must enforce workspace boundaries.

## Isolation

The original repository is never modified.

```text
Original repository
        ↓
Temporary job workspace
        ↓
Migration
        ↓
Verification
        ↓
Actual diff
```

## AI Provider

The system uses an AI provider abstraction with Grok/xAI as the primary provider.

The API key remains backend-only.

## State

Migration state should preserve:

- Job metadata
- Current stage
- Research
- Impact analysis
- Plan
- Commands
- Verification results
- Attempts
- Errors
- Diff
- Final report

## Security Boundaries

- Uploaded archives are treated as untrusted.
- ZIP path traversal is blocked.
- Repository paths are constrained to the job workspace.
- Commands have timeouts/output limits.
- Retry count is bounded.
- Secrets are never sent to the browser.
