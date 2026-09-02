# Agent Trajectories

## Purpose

This document records representative agent executions for the Dependency Major-Version Upgrade Agent.

Each trajectory should show what the agent received, which tools/actions it used, what happened, and how the workflow responded.

Do not expose private model chain-of-thought. Record concise reasoning summaries and observable actions/results only.

---

## 1. Repository Analyzer

### Input

- Repository source
- Repository path
- Migration job ID

### Actions

```text
Inspect repository
→ Detect package.json
→ Detect package manager
→ Detect lockfile
→ Detect scripts
→ Detect language/framework
→ Detect dependencies
```

### Output

Record actual:

- Language
- Package manager
- Lockfile
- Scripts
- Framework
- Dependencies

---

## 2. Migration Research Agent

### Input

- Dependency
- Current version
- Target version
- Repository metadata

### Actions

```text
Identify migration information
→ Retrieve public/official documentation
→ Extract relevant breaking changes
→ Store accessed sources
```

### Output

Record:

- Source URL/title
- Breaking changes
- API/configuration changes
- Compatibility requirements
- Confidence/limitations

Only list sources that were actually accessed.

---

## 3. Impact Analysis Agent

### Input

- Repository
- Dependency
- Migration findings

### Actions

```text
Search repository
→ Inspect relevant files
→ Identify imports/usages/configuration
→ Record affected locations
```

### Output

Record actual:

- Affected files
- Affected usages
- File paths
- Line numbers where available
- Symbols/usages

---

## 4. Migration Agent

### Input

- Migration plan
- Impact analysis
- Repository workspace

### Actions

```text
Read relevant files
→ Update dependency
→ Apply targeted code changes
→ Track modifications
```

### Output

Record:

- Files inspected
- Files modified
- Commands executed
- Patch/diff summary
- Dependency version before/after

---

## 5. Verification Agent

### Input

- Modified repository
- Available package scripts

### Actions

```text
Run supported tests
→ Run build where available
→ Run typecheck where available
→ Run lint where available
→ Capture exit code/output/duration
```

### Output

Record actual:

- Command
- Exit code
- PASS/FAIL/SKIPPED
- Duration
- Relevant stdout/stderr

---

## 6. Failure Diagnosis / Self-Healing Agent

### Trigger

A real verification command fails.

### Input

- Failed command
- Exit code
- stdout
- stderr
- Relevant files
- Migration plan
- Previous attempt information

### Actions

```text
Analyze failure
→ Identify likely cause
→ Inspect relevant files
→ Generate targeted corrective patch
→ Validate/apply patch
→ Retry verification
```

### Output

For each attempt record:

```text
Attempt:
Failure:
Diagnosis summary:
Files changed:
Patch result:
Verification result:
```

Maximum retries: 3.

---

## 7. Human Approval Checkpoint

Before final approval:

```text
Migration complete
→ View actual diff
→ Review final report
→ Approve OR Reject
```

Record the actual state transition.

---

## Representative Run

Paste a real representative execution below.

### Job

- Job ID:
- Repository:
- Dependency:
- Old version:
- Target version:

### Trajectory

```text
[time] Repository analyzed
[time] Research started
[time] Research completed
[time] Impact analysis completed
[time] Migration plan created
[time] Migration applied
[time] Verification started
[time] Verification result
[time] Failure diagnosis (if applicable)
[time] Corrective patch (if applicable)
[time] Retry result
[time] Final verification
```

### Final Result

- Status:
- Attempts:
- Tests:
- Build:
- Typecheck:
- Lint:
- Files changed:
- Remaining issues:
