/**
 * Configurable ZIP ingestion limits (environment-driven, with safe defaults).
 *
 * Repository contents are UNTRUSTED, so every limit here is a hard guard against
 * path traversal and decompression abuse. Each value can be overridden by env to
 * match a deployment's tolerance without touching code.
 */

export interface ZipLimits {
  /** Max bytes of the uploaded archive (compressed). Default 30 MB. */
  maxUploadBytes: number;
  /** Max entries (paths) inside the archive. Default 20 000. */
  maxEntries: number;
  /** Max total uncompressed bytes across all entries. Default 250 MB. */
  maxTotalUncompressedBytes: number;
  /** Max uncompressed bytes of any single entry. Default 50 MB. */
  maxEntryBytes: number;
  /** Max depth (in `/` segments) of any path. Extra-depth entries are rejected. */
  maxPathDepth: number;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const limits: ZipLimits = {
  maxUploadBytes: parseIntEnv("DUA_MAX_UPLOAD_BYTES", 30 * 1024 * 1024),
  maxEntries: parseIntEnv("DUA_MAX_ZIP_ENTRIES", 20_000),
  maxTotalUncompressedBytes: parseIntEnv("DUA_MAX_ZIP_TOTAL_BYTES", 250 * 1024 * 1024),
  maxEntryBytes: parseIntEnv("DUA_MAX_ZIP_ENTRY_BYTES", 50 * 1024 * 1024),
  maxPathDepth: parseIntEnv("DUA_MAX_ZIP_PATH_DEPTH", 64),
};

export function getZipLimits(): ZipLimits {
  return { ...limits };
}