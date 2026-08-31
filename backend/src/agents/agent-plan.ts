/** Structured migration plan produced by the agent. Stored on job state. */
export interface AgentPlan {
  dependency: string;
  fromVersion: string;
  targetVersion: string;
  breakingChanges: string[];
  affectedFiles: string[];
  plannedChanges: string[];
  verificationCommands: string[];
}