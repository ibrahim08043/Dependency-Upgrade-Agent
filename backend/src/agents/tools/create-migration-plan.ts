import { createTool } from "./tool-factory";
import { ToolError } from "./path";
import type { AgentPlan } from "../agent-plan";
import type { ToolContext } from "./context";

interface CreatePlanInput {
  dependency: string;
  from_version: string;
  target_version: string;
  breaking_changes: string[];
  affected_files: string[];
  planned_changes: string[];
  verification_commands: string[];
  migration_findings?: string[];
  affected_apis?: string[];
  risk_assessment?: string[];
  planned_package_changes?: string[];
  planned_source_changes?: string[];
  planned_config_changes?: string[];
  potential_failure_points?: string[];
  research_confidence?: "high" | "medium" | "low" | "none";
}

/**
 * A structured-plan tool. Calling this tool records the plan WITHOUT exposing
 * hidden chain-of-thought to the UI. The plan is persisted to job state by the
 * agent loop (see agents/coding-agent.ts).
 */
export default createTool<CreatePlanInput>({
  name: "create_migration_plan",
  description:
    "Submit the structured migration plan BEFORE making any code changes. Provide the dependency, " +
    "from/to versions, a concise list of breaking changes, the affected file paths, a concise list of " +
    "planned edits, and the verification commands to run. Call this exactly once before editing files.",
  parameters: {
    type: "object",
    properties: {
      dependency: { type: "string" },
      from_version: { type: "string" },
      target_version: { type: "string" },
      breaking_changes: { type: "array", items: { type: "string" } },
      affected_files: { type: "array", items: { type: "string" } },
      planned_changes: { type: "array", items: { type: "string" } },
      verification_commands: { type: "array", items: { type: "string" } },
      migration_findings: { type: "array", items: { type: "string" }, description: "Key research findings that drive this plan." },
      affected_apis: { type: "array", items: { type: "string" }, description: "APIs the repository uses that are affected." },
      risk_assessment: { type: "array", items: { type: "string" }, description: "Which usages are at risk and why." },
      planned_package_changes: { type: "array", items: { type: "string" } },
      planned_source_changes: { type: "array", items: { type: "string" } },
      planned_config_changes: { type: "array", items: { type: "string" } },
      potential_failure_points: { type: "array", items: { type: "string" } },
      research_confidence: { type: "string", enum: ["high", "medium", "low", "none"] },
    },
    required: ["dependency", "from_version", "target_version", "planned_changes", "verification_commands"],
  },
  async run(input, ctx) {
    if (!input.dependency || !input.from_version || !input.target_version) {
      throw new ToolError("INVALID_PLAN", "Plan must include dependency, from_version, and target_version.");
    }
    // Prepare the plan, but record side effects in the agent loop via a reserved
    // return key the loop strips from what the model sees.
    const plan: AgentPlan = {
      dependency: input.dependency,
      fromVersion: input.from_version,
      targetVersion: input.target_version,
      breakingChanges: input.breaking_changes ?? [],
      affectedFiles: input.affected_files ?? [],
      plannedChanges: input.planned_changes ?? [],
      verificationCommands: input.verification_commands ?? [],
      migrationFindings: input.migration_findings ?? [],
      affectedApis: input.affected_apis ?? [],
      riskAssessment: input.risk_assessment ?? [],
      plannedPackageChanges: input.planned_package_changes ?? [],
      plannedSourceChanges: input.planned_source_changes ?? [],
      plannedConfigChanges: input.planned_config_changes ?? [],
      potentialFailurePoints: input.potential_failure_points ?? [],
      researchConfidence: input.research_confidence,
    };
    ctx.log(`Generated migration plan for ${input.dependency}`);
    return { ok: true, result: { accepted: true, __plan: plan } };
  },
});

export type { AgentPlan };