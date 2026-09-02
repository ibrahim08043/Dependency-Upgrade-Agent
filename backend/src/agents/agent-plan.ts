/** Structured migration plan produced by the agent. Stored on job state. */
export interface AgentPlan {
  dependency: string;
  fromVersion: string;
  targetVersion: string;
  breakingChanges: string[];
  affectedFiles: string[];
  plannedChanges: string[];
  verificationCommands: string[];
  /**
   * Phase 2 — research/impact-driven additions. Every planned package/source/
   * config change should reference either a research finding or actual usage.
   */
  migrationFindings?: string[];
  affectedApis?: string[];
  riskAssessment?: string[];
  plannedPackageChanges?: string[];
  plannedSourceChanges?: string[];
  plannedConfigChanges?: string[];
  potentialFailurePoints?: string[];
  researchConfidence?: "high" | "medium" | "low" | "none";
}