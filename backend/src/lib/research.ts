import { randomUUID } from "node:crypto";
import type {
  MigrationResearch,
  ResearchSource,
} from "./research-types";
import { emptyResearch } from "./research-types";

/**
 * Real documentation retrieval for migration research.
 *
 * Sources are discovered from public, stable endpoints (npm registry metadata +
 * the package's official repository/docs when declared) and fetched over HTTP.
 * Only sources that were actually accessed are stored; inaccessible URLs are
 * recorded with status "unavailable" and a reason — never silently replaced
 * with invented content.
 */

const NPM_REGISTRY = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_EXCERPT_BYTES = 6000;

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface NpmPackageMetadata {
  name?: string;
  description?: string;
  homepage?: string;
  repository?: { url?: string; type?: string } | string;
  bugs?: { url?: string } | string;
  license?: string | object;
  "dist-tags"?: Record<string, string>;
  readme?: string;
  versions?: Record<string, { deprecated?: string; description?: string }>;
}

export class ResearchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ResearchError";
    this.code = code;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, headers: { "user-agent": "dependency-upgrade-agent/0.1", ...(init.headers ?? {}) } });
  } finally {
    clearTimeout(timer);
  }
}

/** Extract a plain-text excerpt from an HTML document (best effort, no deps). */
function htmlToText(html: string, max = MAX_EXCERPT_BYTES): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > max) text = `${text.slice(0, max)}…`;
  return text;
}

/** Strip markdown to a short plain-text excerpt. */
function markdownToText(md: string, max = MAX_EXCERPT_BYTES): string {
  let text = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_~>|#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > max) text = `${text.slice(0, max)}…`;
  return text;
}

/**
 * Fetch a public URL and return a short text excerpt.
 * Throws ResearchError.RESEARCH_FETCH_FAILED when the URL cannot be accessed.
 */
export async function fetchPublicUrl(url: string): Promise<{ title: string; text: string }> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url);
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "request timed out" : error instanceof Error ? error.message : String(error);
    throw new ResearchError("RESEARCH_FETCH_FAILED", `Could not fetch ${url}: ${reason}`);
  }
  if (!response.ok) {
    throw new ResearchError("RESEARCH_FETCH_FAILED", `Fetch ${url} returned ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();
  const text = contentType.includes("html")
    ? htmlToText(raw)
    : markdownToText(raw.replace(/\r\n/g, "\n"));
  const title =
    (text.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "")
      .trim()
      .slice(0, 160) ||
    new URL(url).hostname ||
    url;
  return { title, text };
}

/** Record a source that could not be accessed. */
export function markUnavailableSource(
  url: string,
  title: string,
  sourceType: ResearchSource["source_type"],
  reason: string,
): ResearchSource {
  return {
    id: randomUUID(),
    title,
    url,
    source_type: sourceType,
    retrieved_at: new Date().toISOString(),
    status: "unavailable",
    reason,
    key_findings: [],
    excerpt: "",
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new ResearchError("RESEARCH_FETCH_FAILED", `Fetch ${url} returned ${response.status}`);
  return await response.json();
}

/**
 * Discover candidate sources for `<dependency>` major upgrade, prioritizing
 * official: migration guide, release notes, GitHub, npm metadata.
 *
 * Returns discovered sources that were actually fetched, plus any impossible
 * ones flagged as unavailable. Does NOT invent content.
 */
export async function researchDependency(
  dependency: string,
  currentMajor: string,
  targetMajor: string,
): Promise<MigrationResearch> {
  const research = emptyResearch(dependency, currentMajor, targetMajor);
  const npmUrl = `${NPM_REGISTRY}/${encodeURIComponent(dependency)}`;

  // 1) npm metadata (authoritative for version + repo/homepage links)
  let npmMeta: NpmPackageMetadata;
  try {
    npmMeta = (await fetchJson(npmUrl)) as NpmPackageMetadata;
    const readme = npmMeta.readme ?? "";
    const latest = npmMeta["dist-tags"]?.latest ?? targetMajor;
    research.sources.push({
      id: randomUUID(),
      title: `${dependency} npm registry metadata`,
      url: npmUrl,
      source_type: "npm_metadata",
      retrieved_at: new Date().toISOString(),
      status: "retrieved",
      key_findings: [
        `Latest published version: ${latest}`,
        npmMeta.description ? `Description: ${npmMeta.description.slice(0, 200)}` : undefined,
      ].filter(Boolean) as string[],
      excerpt: markdownToText(readme).slice(0, 1500),
    });
  } catch (error) {
    research.sources.push(
      markUnavailableSource(
        npmUrl,
        `${dependency} npm registry metadata`,
        "npm_metadata",
        error instanceof Error ? error.message : String(error),
      ),
    );
    return research; // without npm metadata we have no authoritative links
  }

  // 2) Official repository / docs discovered from npm metadata.
  const repoUrl = typeof npmMeta.repository === "string"
    ? npmMeta.repository
    : npmMeta.repository?.url ?? "";
  const homepage = npmMeta.homepage;
  const candidates: Array<{ url: string; title: string; type: ResearchSource["source_type"] }> = [];

  // Migration/upgrade guide candidates derived from the repo/docs. We fetch the
  // RAW markdown (cleaner, lighter, more accurate excerpting) but record the
  // official blob URL as the source so the user opens a readable page whose
  // content is the same file.
  const repoBase = normalizeGithubRepo(repoUrl, homepage);
  if (repoBase) {
    const guideFiles: Array<[string, ResearchSource["source_type"]]> = [
      ["UPGRADING.md", "official_migration_guide"],
      ["UPGRADE.md", "official_migration_guide"],
      ["MIGRATION.md", "official_migration_guide"],
      ["MIGRATING.md", "official_migration_guide"],
      ["CHANGELOG.md", "changelog"],
    ];
    for (const [file, type] of guideFiles) {
      candidates.push({ url: `${repoBase}/blob/main/${file}`, title: `${dependency} ${file}`, type });
    }
  }

  // Release notes / migration guide on the docs homepage when it looks like a docs site.
  if (homepage && !homepage.includes("github.com")) {
    candidates.push({ url: homepage, title: `${dependency} documentation`, type: "documentation" });
  }

  // 3) GitHub release notes (official release information where available).
  // The npm metadata's repository is GitHub; releases often carry the clearest
  // per-major breaking-change notes. We fetch the releases API and keep only
  // releases that actually mention the target major (or the latest one as a
  // fallback) so the source is tied to the migration, not invented.
  let githubOwnerRepo: string | null = null;
  if (repoBase) {
    const parts = repoBase.replace("https://github.com/", "").split("/");
    if (parts.length >= 2) githubOwnerRepo = `${parts[0]}/${parts[1].replace(/\.git$/, "")}`;
  }

  // Fetch each candidate; record real results and unavailable ones separately.
  for (const candidate of candidates) {
    if (research.sources.length >= 8) break;
    let fetched: { title: string; text: string };
    let fetchUrl = candidate.url;
    try {
      // Prefer the raw markdown for guide/changelog blobs (same content, lighter).
      // The source URL we record is still the readable official blob page.
      if (repoBase && candidate.url.startsWith(`${repoBase}/blob/`)) {
        const rawCandidate = candidate.url.replace(`${repoBase}/blob/`, `${repoBase.replace("github.com", "raw.githubusercontent.com")}/`);
        try {
          fetched = await fetchPublicUrl(rawCandidate);
          fetchUrl = candidate.url; // display the readable blob URL
        } catch {
          fetched = await fetchPublicUrl(candidate.url);
        }
      } else {
        fetched = await fetchPublicUrl(candidate.url);
      }
    } catch (error) {
      research.sources.push(
        markUnavailableSource(
          candidate.url,
          candidate.title,
          candidate.type,
          error instanceof Error ? error.message : String(error),
        ),
      );
      continue;
    }
    const keyFindings = [
      candidate.type === "official_migration_guide"
        ? `Migration guide retrieved for ${dependency} upgrade.`
        : candidate.type === "changelog"
          ? `Changelog retrieved for ${dependency}.`
          : `Documentation retrieved for ${dependency}.`,
    ].filter(Boolean) as string[];
    // Extract a few real "breaking change" mentions from the guide/changelog text
    // so findings are content-derived (never invented).
    if (candidate.type === "official_migration_guide" || candidate.type === "changelog") {
      for (const line of fetched.text.split(/[.\n!?]+/)) {
        if (keyFindings.length >= 4) break;
        const trimmed = line.trim();
        if (
          trimmed.length > 24 &&
          trimmed.length < 220 &&
          /\b(breaking|removed|rename|deprecat|no longer|migrat)\b/i.test(trimmed)
        ) {
          keyFindings.push(trimmed.replace(/\s+/g, " ").slice(0, 200));
        }
      }
    }
    research.sources.push({
      id: randomUUID(),
      title: fetched.title || candidate.title,
      url: fetchUrl,
      source_type: candidate.type,
      retrieved_at: new Date().toISOString(),
      status: "retrieved",
      key_findings: keyFindings,
      excerpt: fetched.text.slice(0, 4000),
    });
  }

  // 4) GitHub release notes (only when the repo is GitHub; best effort).
  if (githubOwnerRepo && research.sources.length < 8) {
    const releasesUrl = `https://api.github.com/repos/${encodeURIComponent(githubOwnerRepo)}/releases?per_page=6`;
    try {
      const releases = (await fetchJson(releasesUrl)) as Array<{
        tag_name?: string;
        name?: string;
        html_url?: string;
        body?: string;
        published_at?: string;
      }>;
      const targetRe = new RegExp(`(^|\\D)v?${escapeRe(targetMajor)}(\\D|$)`);
      const match =
        releases.find((r) => targetRe.test(r.tag_name ?? "") || targetRe.test(r.name ?? "")) ??
        releases[0];
      if (match?.html_url) {
        const bodyText = markdownToText(match.body ?? "");
        research.sources.push({
          id: randomUUID(),
          title: match.name || `${dependency} release ${match.tag_name ?? ""}` || "GitHub release notes",
          url: match.html_url,
          source_type: "official_release_notes",
          retrieved_at: new Date().toISOString(),
          status: "retrieved",
          key_findings: [
            `Release notes retrieved for ${dependency} (${match.tag_name ?? match.published_at ?? "latest"}).`,
            ...bodyText
              .split(/[.\n!?]+/)
              .map((l) => l.trim())
              .filter((l) => l.length > 24 && l.length < 220 && /\b(breaking|removed|rename|deprecat|no longer|migrat)\b/i.test(l))
              .slice(0, 3),
          ],
          excerpt: bodyText.slice(0, 3000),
        });
      } else if (releases.length === 0) {
        research.sources.push(
          markUnavailableSource(releasesUrl, `${dependency} GitHub release notes`, "official_release_notes", "No published releases found for this repository."),
        );
      }
    } catch (error) {
      research.sources.push(
        markUnavailableSource(
          releasesUrl,
          `${dependency} GitHub release notes`,
          "official_release_notes",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  // Determine a baseline confidence from what we actually retrieved.
  const retrieved = research.sources.filter((s) => s.status === "retrieved");
  const hasGuide = retrieved.some((s) => s.source_type === "official_migration_guide");
  const hasReleaseNotes = retrieved.some((s) => s.source_type === "official_release_notes");
  research.confidence = hasGuide
    ? "high"
    : hasReleaseNotes && retrieved.length >= 2
      ? "high"
      : retrieved.length >= 2
        ? "medium"
        : retrieved.length === 1
          ? "low"
          : "none";

  return research;
}

/** Turn a repo URL/homepage into a best-effort GitHub raw/archive base. */
function normalizeGithubRepo(repoUrl: string, homepage: string | undefined): string | null {
  const source = repoUrl || homepage || "";
  const m = /github\.com[:\/]([^\/\s]+\/[^\/\s.#?]+)/.exec(source);
  if (!m) return null;
  return `https://github.com/${m[1].replace(/\.git$/, "")}`;
}
