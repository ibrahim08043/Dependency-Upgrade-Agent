# Reproduction Guide

## 1. Overview

This guide explains how to run and reproduce the Dependency Major-Version Upgrade Agent from a clean environment.

The system targets JavaScript/TypeScript repositories using npm or pnpm and performs dependency major-version migrations inside an isolated temporary workspace.

## 2. Prerequisites

Install the following before starting:

- Node.js (use the version required by the project)
- npm and/or pnpm
- Python 3.x
- Git
- A modern browser

Verify:

```bash
node --version
npm --version
python --version
git --version
pnpm --version
```

## 3. Environment Variables

Create the backend environment file from `.env.example`.

Required:

```env
XAI_API_KEY=
```

Optional:

```env
GITHUB_TOKEN=
DATABASE_URL=
```

`XAI_API_KEY` must never be exposed to frontend code.

## 4. Installation

### Backend

```bash
cd backend
python -m venv .venv
```

Activate the virtual environment and install dependencies:

```bash
pip install -r requirements.txt
```

### Frontend

```bash
cd frontend
npm install
```

Use the package manager and commands documented by the repository if they differ.

## 5. Running the Application

Start the FastAPI backend and Next.js/Vite frontend using the project's configured development commands.

Example backend:

```bash
cd backend
uvicorn app.main:app --reload
```

Example frontend:

```bash
cd frontend
npm run dev
```

Use the actual project scripts if they differ.

## 6. Reproducing a Migration

1. Open the web application.
2. Create a new migration.
3. Upload a real JavaScript/TypeScript repository as a ZIP, or provide a supported GitHub repository URL.
4. Wait for repository analysis.
5. Select an installed dependency.
6. Select the target version/major version.
7. Start the migration.
8. Observe research and impact analysis.
9. Review the generated migration plan.
10. Observe dependency/code changes in the isolated workspace.
11. Observe real test/build/typecheck/lint execution where available.
12. If verification fails, observe the self-healing diagnosis and retry flow.
13. Inspect the actual diff.
14. Review the final report.
15. Approve or reject the migration.

## 7. Expected Evidence

A successful run should expose:

- Repository analysis
- Detected package manager
- Dependency and version information
- Research sources actually accessed
- Affected files/usages
- Migration plan
- Actual modified files
- Actual verification output
- Retry attempts, if any
- Actual diff
- Final report

The application must never fabricate a result when a command or external service fails.

## 8. Evaluation Reproduction

Run the same evaluation cases in both:

- Baseline mode
- Agentic mode

Record:

- Success/failure
- Verification status
- Number of attempts
- Human intervention
- Execution time
- API/token cost where measurable
- Remaining issues

## 9. Security Notes

Repository code is treated as untrusted.

Migrations must run in a temporary isolated workspace. Uploaded ZIP archives must be protected against path traversal. Command execution must enforce workspace boundaries, timeouts, output limits and retry limits.

## 10. Troubleshooting

### Grok is unavailable

Check that `XAI_API_KEY` exists in the backend environment and restart the backend.

### Repository analysis fails

Verify that the repository contains a valid `package.json` and uses JavaScript/TypeScript with npm or pnpm.

### Verification fails

Inspect the command, exit code, stdout/stderr and agent attempt history in the migration workspace.

## 11. Reproducibility Notes

Record the exact:

- Node.js version
- Python version
- package-manager version
- repository commit/ZIP version
- dependency source and target versions
- execution timestamp
- model/API configuration

This makes evaluation results reproducible.
