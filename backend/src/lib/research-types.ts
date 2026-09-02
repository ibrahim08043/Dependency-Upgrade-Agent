/**
 * Structured migration research. Produced by the research stage and persisted
 * on the migration record. Every finding should reference a source that supports
 * it; no item is invented when no reliable source could be accessed.
 */
export type ResearchSourceStatus = "retrieved" | "unavailable";

export interface ResearchSource {
  id: string;
  title: string;
  url: string;
  source_type: "official_migration_guide" | "official_release_notes" | "official_github" | "npm_metadata" | "changelog" | "documentation" | "unavailable";
  retrieved_at: string; // ISO timestamp when actually accessed
  status: ResearchSourceStatus;
  reason?: string; // when status === unavailable
  key_findings: string[];
  excerpt: string; // short, relevant excerpt from the actually-accessed content
}

export type MigrationFindingCategory =
  | "breaking"
  | "removed_api"
  | "renamed_api"
  | "changed_api"
  | "configuration"
  | "import"
  | "compatibility"
  | "upgrade_note";

export interface MigrationFinding {
  category: MigrationFindingCategory;
  title: string;
  description: string;
  /** Optional id of the ResearchSource that backs this finding. */
  sourceId?: string;
  /** URL of the source that backs this finding (synthesis emits sourceUrl). */
  sourceUrl?: string;
  evidence: string; // short excerpt that supports the claim
  confident: boolean; // false when uncertain / undocumented
}

export interface MigrationResearch {
  dependency: string;
  currentVersion: string;
  targetVersion: string;
  sources: ResearchSource[];
  breakingChanges: string[];
  removedApis: string[];
  renamedApis: string[];
  changedApis: string[];
  configurationChanges: string[];
  importChanges: string[];
  compatibilityRequirements: string[];
  upgradeNotes: string[];
  findings: MigrationFinding[];
  confidence: "high" | "medium" | "low" | "none";
}

/** Structured synthesis produced by Grok from retrieved research + repo usage. */
export interface MigrationFindings {
  confidence: "high" | "medium" | "low" | "none";
  breakingChanges: string[];
  removedApis: string[];
  renamedApis: string[];
  changedApis: string[];
  configurationChanges: string[];
  importChanges: string[];
  compatibilityRequirements: string[];
  upgradeNotes: string[];
  findings: Array<{
    category: MigrationFinding["category"];
    title: string;
    description: string;
    sourceUrl: string;
    evidence: string;
    confident: boolean;
  }>;
}

export function emptyResearch(dependency: string, currentVersion: string, targetVersion: string): MigrationResearch {
  return {
    dependency,
    currentVersion,
    targetVersion,
    sources: [],
    breakingChanges: [],
    removedApis: [],
    renamedApis: [],
    changedApis: [],
    configurationChanges: [],
    importChanges: [],
    compatibilityRequirements: [],
    upgradeNotes: [],
    findings: [],
    confidence: "none",
  };
}
