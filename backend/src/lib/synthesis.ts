/**
 * Grok research + impact synthesis.
 *
 * Takes only the ACTUALLY-RETRIEVED research material and the ACTUALLY-DETECTED
 * repository usage, and asks the real Grok provider to produce a structured,
 * evidence-based migration knowledge summary. We do NOT send the whole repo and
 * we explicitly instruct the model to use only the supplied context, to mark
 * uncertain items, and to say so when no reliable migration info was found.
 */
import type { GrokProvider } from "../services/ai/types";
import { ResearchError } from "./research";
import type { MigrationFindings, MigrationFindingCategory } from "./research-types";

export interface SynthesisInput {
  dependency: string;
  currentVersion: string;
  targetVersion: string;
  /** Concatenated excerpts from retrieved sources only. */
  researchContext: Array<{ title: string; url: string; excerpt: string; source_type: string }>;
  /** Repository structural facts the model may reference. */
  repoContext: {
    language: string;
    packageManager: string;
    packageJson: string;
    fileTree: string;
    affectedUsage: Array<{ file: string; line: number; type: string; symbol: string; code: string }>;
  };
}

const SYSTEM_PROMPT = `You are the Dependency Upgrade migration research analyst.

You must produce a structured, EVIDENCE-BASED migration knowledge summary for
upgrading the given dependency between two major versions.

STRICT RULES:
- Use ONLY the supplied "RESEARCH CONTEXT" (retrieved from real public sources)
  and the supplied "REPOSITORY CONTEXT". Do not invent undocumented breaking changes.
- If information is uncertain, set confident=false and note it.
- If no reliable migration information was found in the research context, say so
  explicitly (confidence="none") rather than guessing.
- Output ONLY a JSON object. No markdown, no commentary, no chain-of-thought.`;

/**
 * Ask Grok to synthesize structured findings from retrieved research + repo usage.
 * Returns a typed MigrationFindings object. Throws ResearchError.RESEARCH_SYNTHESIS_FAILED
 * if Grok cannot produce parseable JSON.
 */
export async function synthesizeFindings(
  provider: GrokProvider,
  input: SynthesisInput,
): Promise<MigrationFindings> {
  const userPrompt = buildUserPrompt(input);

  let completion;
  try {
    completion = await provider.chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    );
  } catch (error) {
    throw new ResearchError("RESEARCH_SYNTHESIS_FAILED", `Grok synthesis request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const content = completion.summary ?? "";
  return parseFindings(content);
}

function buildUserPrompt(input: SynthesisInput): string {
  const research = input.researchContext
    .map(
      (s) =>
        `[SOURCE] title=${s.title} url=${s.url} type=${s.source_type}\nexcerpt=${s.excerpt.slice(0, 2000)}`,
    )
    .join("\n\n");

  const usage = input.repoContext.affectedUsage
    .map((u) => `${u.file}:${u.line} [${u.type}] ${u.symbol} — ${u.code}`)
    .slice(0, 300)
    .join("\n");

  return `DEPENDENCY: ${input.dependency}
CURRENT VERSION: ${input.currentVersion}
TARGET VERSION: ${input.targetVersion}

RESEARCH CONTEXT (only these sources were actually retrieved):
${research || "(no sources were retrievable)"}

REPOSITORY CONTEXT:
- language=${input.repoContext.language}
- packageManager=${input.repoContext.packageManager}
- package.json:
${input.repoContext.packageJson.slice(0, 3000)}
- file tree (truncated):
${input.repoContext.fileTree.slice(0, 3000)}
- detected usages of the dependency:
${usage || "(none detected)"}

Return JSON with this exact shape:
{
  "confidence": "high"|"medium"|"low"|"none",
  "breaking_changes": ["..."],
  "removed_apis": ["..."],
  "renamed_apis": ["..."],
  "changed_apis": ["..."],
  "configuration_changes": ["..."],
  "import_changes": ["..."],
  "compatibility_requirements": ["..."],
  "upgrade_notes": ["..."],
  "findings": [
    {
      "category": "breaking"|"removed_api"|"renamed_api"|"changed_api"|"configuration"|"import"|"compatibility"|"upgrade_note",
      "title": "...",
      "description": "...",
      "sourceUrl": "...",
      "evidence": "...",
      "confident": true|false
    }
  ]
}`;
}

/**
 * Deterministic fallback used when Grok is unavailable (no key, or the provider
 * throws). It derives a MINIMAL, honest findings object from the sources that
 * were actually retrieved — it never invents breaking-change details. When no
 * official guide was retrieved, confidence is "none" and the caller surfaces
 * "Reliable migration information could not be established."
 */
export function fallbackFindingsFromSources(
  sources: Array<{ title: string; url: string; source_type: string; excerpt: string }>,
): MigrationFindings {
  const retrieved = sources.filter((s) => s.source_type !== "unavailable");
  const hasGuide = retrieved.some((s) => s.source_type === "official_migration_guide");
  const hasChangelog = retrieved.some((s) => s.source_type === "changelog" || s.source_type === "official_release_notes");

  const findings: MigrationFindings["findings"] = [];
  if (hasGuide || hasChangelog) {
    const cat: MigrationFindingCategory = hasGuide ? "breaking" : "upgrade_note";
    const src = retrieved.find((s) => s.source_type === "official_migration_guide" || s.source_type === "changelog")!;
    findings.push({
      category: cat,
      title: `Source retrieved: ${src.title}`,
      description: `The official ${src.source_type === "official_migration_guide" ? "migration guide" : "changelog"} was fetched successfully. Review its contents for breaking changes.`,
      sourceUrl: src.url,
      evidence: src.excerpt.slice(0, 400),
      confident: false,
    });
  } else if (retrieved.length > 0) {
    const src = retrieved[0];
    findings.push({
      category: "upgrade_note",
      title: `Retrieved ${src.title}`,
      description: "A documentation source was retrieved, but no dedicated migration guide was found. Review carefully.",
      sourceUrl: src.url,
      evidence: src.excerpt.slice(0, 400),
      confident: false,
    });
  }

  return {
    confidence: hasGuide ? "low" : hasChangelog ? "low" : retrieved.length > 0 ? "low" : "none",
    breakingChanges: [],
    removedApis: [],
    renamedApis: [],
    changedApis: [],
    configurationChanges: [],
    importChanges: [],
    compatibilityRequirements: [],
    upgradeNotes: [],
    findings,
  };
}

function parseFindings(content: string): MigrationFindings {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```.*$/s, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract the first {...} block as a fallback.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        throw new ResearchError("RESEARCH_SYNTHESIS_FAILED", "Grok did not return parseable JSON.");
      }
    } else {
      throw new ResearchError("RESEARCH_SYNTHESIS_FAILED", "Grok did not return parseable JSON.");
    }
  }
  const p = parsed as Record<string, unknown>;
  const arr = (key: string): string[] =>
    Array.isArray(p[key]) ? (p[key] as string[]).map(String) : [];

  const findingsRaw = Array.isArray(p.findings) ? (p.findings as Array<Record<string, unknown>>) : [];
  const findings = findingsRaw.map((f) => ({
    category: (f.category as MigrationFindings["findings"][number]["category"]) ?? "upgrade_note",
    title: String(f.title ?? ""),
    description: String(f.description ?? ""),
    sourceUrl: String(f.sourceUrl ?? ""),
    evidence: String(f.evidence ?? ""),
    confident: f.confident !== false,
  }));

  return {
    confidence: (p.confidence as MigrationFindings["confidence"]) ?? "none",
    breakingChanges: arr("breaking_changes"),
    removedApis: arr("removed_apis"),
    renamedApis: arr("renamed_apis"),
    changedApis: arr("changed_apis"),
    configurationChanges: arr("configuration_changes"),
    importChanges: arr("import_changes"),
    compatibilityRequirements: arr("compatibility_requirements"),
    upgradeNotes: arr("upgrade_notes"),
    findings,
  };
}
