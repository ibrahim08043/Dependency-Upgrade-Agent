# Evaluation

## Objective

Measure whether the agentic workflow improves dependency major-version migration outcomes compared with a simple baseline.

## Baseline

```text
Update dependency
→ Run verification once
```

## Agentic System

```text
Research
→ Impact analysis
→ Plan
→ Migration
→ Verification
→ Failure diagnosis
→ Corrective patch
→ Retry
→ Final verification
```

## Evaluation Set

Target at least 10 realistic migration cases when the task set permits.

Each case should contain:

- Repository
- Dependency
- Current version
- Target version
- Expected migration challenge
- Verification commands

Include at least one challenging case.

## Metrics

Record actual values for:

- Successful migrations
- Failed migrations
- Test pass rate
- Build pass rate
- Typecheck pass rate
- Average attempts
- Human intervention
- Average execution time
- API/token cost where measurable
- Remaining issues

## Results

| Case | Baseline | Agentic | Baseline Attempts | Agentic Attempts | Human Intervention | Notes |
|---|---|---|---:|---:|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |
| 6 | | | | | | |
| 7 | | | | | | |
| 8 | | | | | | |
| 9 | | | | | | |
| 10 | | | | | | |

## Aggregate Results

| Metric | Baseline | Agentic | Difference |
|---|---:|---:|---:|
| Successful migrations | | | |
| Test pass rate | | | |
| Build pass rate | | | |
| Average attempts | | | |
| Human intervention | | | |
| Average execution time | | | |
| Average cost | | | |

## Interpretation

Only make claims supported by the recorded results.

Example:

> The agentic workflow improved [metric] from [baseline] to [agentic] across [N] evaluated cases.

## Limitations

Document:

- Unsupported ecosystems
- Repository-specific assumptions
- Cases where migration research was insufficient
- Cases requiring human intervention
- API/model limitations
- Execution environment limitations
