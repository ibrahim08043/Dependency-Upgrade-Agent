/**
 * Secure ZIP ingestion: parse + validate + extract with cleanup.
 *
 * Repository contents are UNTRUSTED.  We do NOT trust the OS `unzip`/`tar`
 * listing alone (names only, cross-platform parsing is unreliable).  Instead we
 * parse the ZIP central directory from the uploaded bytes ourselves (pure Node,
 * no deps) so we know every entry NAME and UNCOMPRESSED SIZE *before* we extract.
 *
 * Validation (all limits from ./zip-config):
 *   - archive (compressed) upload size
 *   - entry count
 *   - per-entry uncompressed size
 *   - total uncompressed size
 *   - path safety (no absolute variant, no `..`, no trailing-surprise, bounded depth)
 *
 * If anything fails we throw a ZipSecurityError with a machine-readable code and
 * remove the half-created workspace so no partial extraction survives.
 */
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getZipLimits, type ZipLimits } from "./zip-config";
import { extractArchive, copyDirectory } from "./workspace";

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
/** An EOCD record can appear anywhere in the final 65,535 bytes + 22-byte header. */
const MAX_EOCD_SEARCH = 65_535 + 22;

export interface ZipEntryInfo {
  /** Path as stored in the archive (POSIX-style `a/b/c.txt`). */
  name: string;
  /** Uncompressed byte length (0 for directory entries). */
  uncompressedSize: number;
  isDirectory: boolean;
}

export class ZipSecurityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ZipSecurityError";
    this.code = code;
  }
}

function leU16(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

function leU32(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

function leU64(buf: Buffer, offset: number): number {
  const hi = buf.readUInt32LE(offset + 4);
  const lo = buf.readUInt32LE(offset);
  // JS numbers are exact for < 2^53; 256MB+ is far below that.
  return hi * 0x1_0000_0000 + lo;
}

/** Locate the End of Central Directory and return its byte offset. Throws if absent. */
function findEocd(buf: Buffer): number {
  const start = Math.max(0, buf.length - MAX_EOCD_SEARCH);
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipSecurityError("INVALID_ZIP", "Not a valid ZIP archive (EOCD record not found)");
}

interface CdLocation {
  offset: number;
  size: number;
  count: number;
}

/** Resolve the central-directory location, honoring ZIP64 when present. */
function locateCentralDirectory(buf: Buffer, eocdOffset: number): CdLocation {
  let count = leU16(buf, eocdOffset + 10);
  let size = leU32(buf, eocdOffset + 12);
  let offset = leU32(buf, eocdOffset + 16);

  // All three set to 0xFFFFFFFF signals ZIP64.
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    // ZIP64 locator sits 20 bytes before the EOCD.
    const locator = eocdOffset - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === ZIP64_LOCATOR_SIG) {
      const zip64EocdOffset = Number(leU64(buf, locator + 8));
      if (zip64EocdOffset >= 0 && zip64EocdOffset + 56 <= buf.length &&
          buf.readUInt32LE(zip64EocdOffset) === ZIP64_EOCD_SIG) {
        count = Number(leU64(buf, zip64EocdOffset + 32));
        size = Number(leU64(buf, zip64EocdOffset + 40));
        offset = Number(leU64(buf, zip64EocdOffset + 48));
      }
    }
  }
  if (offset < 0 || offset + size > buf.length) {
    throw new ZipSecurityError("INVALID_ZIP", "ZIP central directory is out of bounds");
  }
  return { offset, size, count };
}

/**
 * Parse the ZIP central directory into entry infos. Throws ZipSecurityError on a
 * malformed archive. This is a pure-buffer operation — nothing is extracted and no
 * entry is expanded, so a bomb cannot be triggered by validation itself.
 */
export function parseZipEntries(buf: Buffer): ZipEntryInfo[] {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    throw new ZipSecurityError("INVALID_ZIP", "Upload is too small to be a ZIP archive");
  }
  const eocd = findEocd(buf);
  const { offset, size, count } = locateCentralDirectory(buf, eocd);
  const entries: ZipEntryInfo[] = [];
  let cursor = offset;
  const end = offset + size;

  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > end) {
      throw new ZipSecurityError("INVALID_ZIP", "ZIP central directory is truncated");
    }
    if (buf.readUInt32LE(cursor) !== CD_SIG) {
      throw new ZipSecurityError("INVALID_ZIP", "ZIP central directory is corrupted");
    }
    const method = leU16(buf, cursor + 10);
    const compressedSize = leU32(buf, cursor + 20);
    let uncompressedSize = leU32(buf, cursor + 24);
    const nameLength = leU16(buf, cursor + 28);
    const extraLength = leU16(buf, cursor + 30);
    const commentLength = leU16(buf, cursor + 32);

    const nameStart = cursor + 46;
    if (nameStart + nameLength + extraLength + commentLength > end) {
      throw new ZipSecurityError("INVALID_ZIP", "ZIP entry header is truncated");
    }
    let name = buf.toString("utf8", nameStart, nameStart + nameLength);

    // ZIP64 extra field holds real sizes when the fixed fields are 0xFFFFFFFF.
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff) {
      const extraStart = nameStart + nameLength;
      const extra = buf.subarray(extraStart, extraStart + extraLength);
      let p = 0;
      while (p + 4 <= extra.length) {
        const id = leU16(extra, p);
        const len = leU16(extra, p + 2);
        if (id === ZIP64_EXTRA_ID) {
          let q = p + 4;
          const rawValues: number[] = [];
          while (q + 8 <= Math.min(p + 4 + len, extra.length)) {
            rawValues.push(Number(leU64(extra, q)));
            q += 8;
          }
          // Order: original size, compressed size, local header offset, disk start.
          if (uncompressedSize === 0xffffffff) uncompressedSize = rawValues[0] ?? uncompressedSize;
          break;
        }
        p += 4 + len;
      }
    }

    const isDirectory = name.endsWith("/") || name.endsWith("\\");
    if (!isDirectory && method === 0) {
      // Stored entries have no compression to relax; keep the parsed size.
    }
    entries.push({ name, uncompressedSize, isDirectory });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** Detect an absolute path in any variant (POSIX, Windows drive, UNC). */
export function isUnsafePathSegment(segments: string[]): boolean {
  if (segments.length === 0) return true;
  const first = segments[0];
  if (first === "" ) return true; // leading slash handled separately
  if (/^[a-zA-Z]:$/.test(first)) return true; // Windows drive "C:"
  return false;
}

/**
 * Validate parsed entries against the configured limits and path-safety rules.
 * Throws ZipSecurityError with a machine-readable code on any violation.
 */
export function validateZipEntries(entries: ZipEntryInfo[], limits: ZipLimits): void {
  if (entries.length === 0) {
    throw new ZipSecurityError("INVALID_ZIP", "ZIP archive contains no entries");
  }
  if (entries.length > limits.maxEntries) {
    throw new ZipSecurityError(
      "ZIP_SIZE_LIMIT",
      `ZIP contains too many entries (${entries.length}; limit ${limits.maxEntries})`,
    );
  }

  let total = 0;
  for (const entry of entries) {
    // --- Path safety ---
    // Normalize backslashes and collapse any remaining `.`/`..` via segments.
    const normalized = entry.name.replace(/\\/g, "/");
    // Strip any leading drive/UNC.
    const segments = normalized.split("/");

    const first = segments[0];
    if (first === "" || /^[a-zA-Z]:$/.test(first) || (first.startsWith("//"))) {
      throw new ZipSecurityError(
        "ZIP_PATH_TRAVERSAL",
        `ZIP entry uses an absolute/rooted path: "${entry.name}"`,
      );
    }
    if (segments.some((seg) => seg === "..")) {
      throw new ZipSecurityError(
        "ZIP_PATH_TRAVERSAL",
        `ZIP entry contains path traversal: "${entry.name}"`,
      );
    }
    if (segments.length > limits.maxPathDepth) {
      throw new ZipSecurityError(
        "ZIP_PATH_TRAVERSAL",
        `ZIP entry path is too deep: "${entry.name}"`,
      );
    }

    // --- Decompression abuse ---
    if (!entry.isDirectory && entry.uncompressedSize > limits.maxEntryBytes) {
      throw new ZipSecurityError(
        "ZIP_SIZE_LIMIT",
        `ZIP entry is too large: "${entry.name}" (${entry.uncompressedSize} bytes; limit ${limits.maxEntryBytes})`,
      );
    }
    total += entry.uncompressedSize;
    if (total > limits.maxTotalUncompressedBytes) {
      throw new ZipSecurityError(
        "ZIP_SIZE_LIMIT",
        `ZIP total uncompressed size exceeds limit (${total} bytes; limit ${limits.maxTotalUncompressedBytes})`,
      );
    }
  }
}

/**
 * Validate the upload buffer's size (compressed) against the configured limit.
 */
export function assertUploadSize(bytes: Buffer, limits: ZipLimits): void {
  if (bytes.length > limits.maxUploadBytes) {
    throw new ZipSecurityError(
      "FILE_TOO_LARGE",
      `Upload is ${bytes.length} bytes; limit is ${limits.maxUploadBytes}`,
    );
  }
}

/**
 * Full safe-ingest flow used by both ZIP upload and (via createRepositoryWorkspace)
 * GitHub imports:
 *
 *   1. size check (compressed)
 *   2. parse + validate central directory (names + uncompressed sizes)
 *   3. create an isolated job workspace `<temp>/dependency-agent/<uuid>/`
 *   4. write the archive, extract into `original/`, copy into `workspace/`
 *   5. on ANY failure, remove the whole job workspace so no partial extraction leaks
 *
 * Returns the job workspace paths. The ZIP bytes are never extracted into the
 * application's own source tree.
 */
export async function extractZipToWorkspace(
  bytes: Buffer,
  filename: string,
  limits: ZipLimits = getZipLimits(),
): Promise<{ rootPath: string; originalPath: string; jobRoot: string }> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new ZipSecurityError("INVALID_FILE_TYPE", "Empty upload");
  }
  assertUploadSize(bytes, limits);
  const entries = parseZipEntries(bytes);
  validateZipEntries(entries, limits);

  const parent = path.join(tmpdir(), "dependency-agent");
  await mkdir(parent, { recursive: true });
  const jobRoot = await mkdtemp(path.join(parent, "repo-"));
  const originalPath = path.join(jobRoot, "original");
  const workPath = path.join(jobRoot, "workspace");
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-120) || "repository.zip";
  const archive = path.join(jobRoot, safeFilename.endsWith(".zip") ? safeFilename : "repository.zip");

  try {
    await mkdir(originalPath, { recursive: true });
    await mkdir(workPath, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(archive, bytes);

    // Defense-in-depth: extract with the OS tool, then verify the extracted tree
    // still only contains safe, non-escaping paths. This catches engines that
    // mishandle weird names (e.g. Windows bsdtar backslash quirks).
    await extractArchive(archive, originalPath);
    await assertExtractedTree(originalPath);

    await copyDirectory(originalPath, workPath);
    return { rootPath: workPath, originalPath, jobRoot };
  } catch (error) {
    await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Walk the extracted directory and confirm every path is inside `root`.  Provides
 * an extra boundary on top of the central-directory review (catches engine-level
 * decompression surprises). Throws EXTRACTION_FAILED on anything unexpected.
 */
export async function assertExtractedTree(root: string): Promise<void> {
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  const seen = new Set<string>();

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.resolve(dir, entry.name);
      if (abs !== root && !abs.startsWith(rootWithSep)) {
        throw new ZipSecurityError("EXTRACTION_FAILED", `Extracted path escapes the workspace: ${abs}`);
      }
      if (seen.has(abs)) {
        throw new ZipSecurityError("EXTRACTION_FAILED", `Duplicate extracted path: ${abs}`);
      }
      seen.add(abs);
      if (entry.isDirectory()) {
        await visit(abs);
      } else if (entry.isSymbolicLink()) {
        // Reject symlinks entirely: they can sneak an escape that a later read follows.
        throw new ZipSecurityError("EXTRACTION_FAILED", "ZIP entries must not contain symlinks");
      }
    }
  }

  await visit(root);
}

/** Remove a job workspace (used for cleanup after analysis or on cancel). */
export async function removeWorkspace(jobRoot: string): Promise<void> {
  if (!jobRoot || !jobRoot.startsWith(path.join(tmpdir(), "dependency-agent"))) return;
  await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined);
}

export { getZipLimits } from "./zip-config";
export type { ZipLimits } from "./zip-config";