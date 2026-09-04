/**
 * Self-healing: failure diagnosis + corrective repair orchestration.
 *
 * When verification fails, we give Grok the exact failed command context plus the
 * repository research/plan/usage, ask it for a concise diagnosis (not chain of
 * thought), then run a REPAIR pass of the coding agent against the diagnosis.
 * The whole loop is bounded by MAX_HEAL_ATTEMPTS — never infinite.
 */

import type { GrokProvider } from "../services/ai/types";
import { ResearchError } from "./research";

export const MAX_HEAL_ATTEMPTS = 2;

export interface FailureDiagnosisInput {
  dependency: string;
  oldVersion: string;
  targetVersion: string;
  researchSummary: string;
  planSummary: string;
  impactSummary: string;
  failedCommands: Array<{ command: string; exitCode: number; stdout: string; stderr: string }>;
  filesModified: string[];
  affectedFiles: string[];
}

export interface FailureDiagnosis {
  summary: string;
  failedCommands: string[];
}

const SYSTEM_PROMPT = `You are the Dependency Upgrade failure-analysis analyst.

The migration made changes to an isolated copy of a repository, then its
verification commands failed. Your job is to diagnose the ROOT CAUSE concisely.

STRICT RULES:
- Use ONLY the supplied context: the failed commands' real stdout/stderr/exit codes,
  the research, the plan, and the files the agent changed.
- Output a clear, short diagnosis of WHAT failed and WHY, and the smallest safe fix.
- Never expose hidden chain-of-thought, never claim success, never invent output.
- Respond with ONLY a JSON object:
  {"summary": "<2-3 sentence diagnosis + smallest fix>"}`;

export class HealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HealError";
  }
}

function buildInputText(input: FailureDiagnosisInput): string {
  const commands = input.failedCommands
    .map(
      (c) =>
        `$ ${c.command}\nexit=${c.exitCode}\nstdout:\n${(c.stdout || "").slice(0, 1500)}\nstderr:\n${(c.stderr || "").slice(0, 1500)}`,
    )
    .join("\n\n---\n\n");

  return `DEPENDENCY: ${input.dependency} ${input.oldVersion} → ${input.targetVersion}

RESEARCH:
${input.researchSummary || "(none)"}

PLAN:
${input.planSummary || "(none)"}

IMPACT:
${input.impactSummary || "(none)"}

FILES MODIFIED BY THE AGENT:
${input.filesModified.join("\n") || "(none)"}

AFFECTED FILES:
${input.affectedFiles.join("\n") || "(none)"}

FAILED VERIFICATION COMMANDS:
${commands || "(none)"}`;
}

/**
 * Ask Grok to diagnose a verification failure. Returns a concise summary and the
 * list of failed commands it was told about. Throws HealError on no parseable JSON.
 */
export async function diagnoseFailure(
  provider: GrokProvider,
  input: FailureDiagnosisInput,
): Promise<FailureDiagnosis> {
  if (!provider) throw new HealError("HEAL_UNAVAILABLE: no Grok provider for diagnosis");
  let completion;
  try {
    completion = await provider.chat([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildInputText(input) },
    ]);
  } catch (error) {
    throw new HealError(`HEAL_DIAGNOSIS_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  const clean = (completion.summary ?? "").replace(/^```(?:json)?\s*/i, "").replace(/```.*$/s, "").trim();
  try {
    const parsed = JSON.parse(clean) as { summary?: string };
    return { summary: (parsed.summary && parsed.summary.trim()) ? parsed.summary : "No diagnosis summary returned.", failedCommands: input.failedCommands.map((c) => c.command) };
  } catch {
    throw new HealError("HEAL_DIAGNOSIS_FAILED: Grok did not return parseable JSON.");
  }
}
