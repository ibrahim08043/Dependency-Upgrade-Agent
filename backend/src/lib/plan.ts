/**
 * Deterministic migration-plan fallback.
 *
 * The coding agent's `create_migration_plan` tool produces the rich agent plan
 * when Grok is available. When no agent plan was produced (no key, Grok error,
 * or baseline mode), this module builds an honest structured plan from data the
 * pipeline actually has: the dependency/versions, the retrieved research, and
 * the real impact analysis. No field is invented — every section is derived
 * from persisted state, and anything unknown is stated as such.
 */

import type { MigrationRecord } from "./migration-state";
import type { ImpactSummary } from "./impact";
import type { MigrationResearch } from "./research-types";

export interface FallbackPlanInput {
  dependency: string;
  currentVersion: string;
  targetVersion: string;
  research: MigrationResearch | null;
  riskSummary: ImpactSummary | null;
  packageManager: string;
  scripts: string[];
  language: string;
  /** What actually happened to the repository so far (from migration.changes). */
  changes: string[];
  /** Whether an agent pass ran (affects how source changes are described). */
  agentRan: boolean;
}

const VALIDATION_SCRIPTS = ["test", "build", "typecheck", "lint"] as const;

/**
 * Build a structured plan from real research + impact + repo metadata.
 * Returns the same display shape as the agent plan (MigrationRecord["plan"]).
 */
export function buildFallbackPlan(input: FallbackPlanInput): NonNullable<MigrationRecord["plan"]> {
  const {
    dependency,
    currentVersion,
    targetVersion,
    research,
    riskSummary,
    packageManager,
    scripts,
    language,
    changes,
    agentRan,
  } = input;

  const breakingChanges = [...(research?.breakingChanges ?? [])];
  const importChanges = [...(research?.importChanges ?? [])];
  const configChanges = [...(research?.configurationChanges ?? [])];
  const removed = [...(research?.removedApis ?? [])];
  const renamed = [...(research?.renamedApis ?? [])];
  const changed = [...(research?.changedApis ?? [])];
  const upgradeNotes = [...(research?.upgradeNotes ?? [])];

  const affectedApis = [...(riskSummary?.affectedApis ?? [])];
  const affectedFiles = [...new Set(riskSummary?.findings?.map((f) => f.filePath) ?? [])];

  const plannedSourceChanges: string[] = [];
  if (removed.length) plannedSourceChanges.push(`Remove/replace removed APIs: ${removed.join("; ")}.`);
  if (renamed.length) plannedSourceChanges.push(`Rename usages of: ${renamed.join("; ")}.`);
  if (changed.length) plannedSourceChanges.push(`Review changed-API usages: ${changed.join("; ")}.`);
  if (affectedApis.length) plannedSourceChanges.push(`Audit affected APIs actually used in the repo: ${affectedApis.join(", ")}.`);
  if (importChanges.length) plannedSourceChanges.push(`Apply import changes: ${importChanges.join("; ")}.`);
  if (plannedSourceChanges.length === 0) {
    plannedSourceChanges.push(
      agentRan
        ? "No source-level changes were flagged by research for the repository's usage."
        : "No source changes were attempted (agent code migration was not run in this mode).",
    );
  }

  const plannedConfigChanges = configChanges.length
    ? configChanges
    : research?.compatibilityRequirements?.length
      ? research.compatibilityRequirements
      : [];

  const validationCommands = VALIDATION_SCRIPTS.filter((s) => scripts.includes(s)).map(
    (s) => `${packageManager} run ${s}`,
  );

  const potentialFailurePoints: string[] = [];
  if (removed.length || renamed.length) {
    potentialFailurePoints.push("APIs removed/renamed in the target major may break existing call sites.");
  }
  if (research?.compatibilityRequirements?.length) {
    potentialFailurePoints.push("New compatibility requirements may affect the build/runtime environment.");
  }

  return {
    summary: `Migration plan for ${dependency} ${currentVersion} → ${targetVersion}`,
    breakingChanges,
    plannedChanges: [
      ...(changes.length ? changes : [`Update ${dependency} to ${targetVersion} in the package manifest.`]),
      ...plannedSourceChanges,
      ...(plannedConfigChanges.length ? [`Configuration: ${plannedConfigChanges.join("; ")}`] : []),
      ...(validationCommands.length ? [`Verify with: ${validationCommands.join(", ")}`] : ["No verification scripts detected."]),
    ],
    validationCommands,
    migrationFindings: upgradeNotes,
    affectedApis,
    riskAssessment: [
      `Repository is ${language}; package manager ${packageManager}.`,
      riskSummary
        ? `${riskSummary.affectedFiles} affected file(s), ${riskSummary.affectedUsages} usage(s); ${riskSummary.high} high, ${riskSummary.medium} medium, ${riskSummary.low} low risk.`
        : "No usage-level risk data was available.",
    ],
    plannedPackageChanges: [`Update ${dependency} from ${currentVersion} to ${targetVersion} (${packageManager}).`],
    plannedSourceChanges,
    plannedConfigChanges,
    potentialFailurePoints,
    researchConfidence: research?.confidence ?? "none",
  };
}
