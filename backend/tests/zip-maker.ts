/**
 * Test helper: build ZIP archives (real and hand-crafted) without external tools.
 *
 * A ZIP we build ourselves is fully controlled, so we can craft:
 *   - valid archives (with nested roots)
 *   - traversal entries (../evil, absolute paths)
 *   - entries declaring huge uncompressed sizes (ZIP-bomb)
 *   - too many entries
 *
 * We emit minimal "stored" (method 0) ZIPs: a local file header, raw data, a
 * central directory, and an End-Of-Central-Directory record. This is well within
 * ZIP spec and parses with node's `zlib`/our own central-directory reader.
 */
import { deflateSync } from "node:zlib";

const DOS_EPOCH = ((1 << 9) | (1 << 5)) >>> 0; // 1980-01-01 00:00 local-ish

interface ZipEntry {
  name: string;
  data: Buffer;
  /** Force the uncompressed size field to lie (for bomb tests). */
  forceUncompressedSize?: number;
  method?: 0 | 8; // 0=store, 8=deflate
}

// CRC-32 table (IEEE). Dependency-free so test tooling works on any Node.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc(input: Buffer): number {
  try {
    const { crc32 } = require("node:zlib") as { crc32?: (b: Buffer) => number };
    if (typeof crc32 === "function") return crc32(input) >>> 0;
  } catch {
    /* fall through */
  }
  let crcValue = 0xffffffff;
  for (let i = 0; i < input.length; i += 1) {
    crcValue = CRC_TABLE[(crcValue ^ input[i]) & 0xff] ^ (crcValue >>> 8);
  }
  return (crcValue ^ 0xffffffff) >>> 0;
}

/**
 * Build a ZIP archive buffer from entries.
 *
 * If `traversal` is set, the entry name is used verbatim (even "../evil").
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const { name, data, forceUncompressedSize, method = 0 } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const useDeflate = method === 8;
    const stored = useDeflate ? deflateSync(data, { level: 9 }) : data;
    const crcValue = crc(data);
    const uncompressedSize = forceUncompressedSize ?? data.length;
    const compressedSize = useDeflate ? stored.length : data.length;

    // --- Local file header (30 bytes) ---
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags (UTF-8)
    local.writeUInt16LE(method, 8); // compression method
    local.writeUInt16LE(DOS_EPOCH, 10); // mod time
    local.writeUInt16LE(DOS_EPOCH, 12); // mod date
    local.writeUInt32LE(crcValue, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    chunks.push(local, nameBuf, stored);

    // --- Central directory header (46 bytes) ---
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8); // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_EPOCH, 12);
    cd.writeUInt16LE(DOS_EPOCH, 14);
    cd.writeUInt32LE(crcValue, 16);
    cd.writeUInt32LE(compressedSize, 20);
    cd.writeUInt32LE(uncompressedSize, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + stored.length;
  }

  // --- End of central directory ---
  const cdStart = chunks.reduce((sum, c) => sum + c.length, 0);
  const cdSize = central.reduce((sum, c) => sum + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...chunks, ...central, eocd]);
}

/** Build a simple valid repo ZIP with a package.json + src. */
export function buildValidRepoZip(opts?: { nested?: boolean; name?: string; withPnpm?: boolean }): Buffer {
  const prefix = opts?.nested ? "my-project/" : "";
  const deps = opts?.withPnpm
    ? { dependencies: { react: "^18.3.1" } }
    : { dependencies: { axios: "^0.27.2" } };
  const lockfile = opts?.withPnpm
    ? [{ name: `${prefix}pnpm-lock.yaml`, data: Buffer.from("lockfileVersion: '6.0'\n", "utf8") }]
    : [];
  return buildZip([
    {
      name: `${prefix}package.json`,
      data: Buffer.from(
        JSON.stringify(
          { name: opts?.name ?? "fixture", version: "1.0.0", scripts: { test: "echo ok", build: "echo ok" }, ...deps },
          null,
          2,
        ),
        "utf8",
      ),
    },
    { name: `${prefix}src/index.js`, data: Buffer.from('const a = require("axios");\n', "utf8") },
    ...lockfile,
  ]);
}