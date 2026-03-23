import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CachedFile {
  path: string;
  content: string;
  analysis: {
    exports: string[];
    todoComments: string[];
    functionCount: number;
    classCount: number;
    isReact: boolean;
    isTypeScript: boolean;
    isTest: boolean;
    isConfig: boolean;
    hasJsx: boolean;
    logicType: string;
    lineCount: number;
    codeLines: number;
  };
  metrics: {
    lineCount: number;
    codeLines: number;
    emptyLines: number;
    commentLines: number;
    charCount: number;
  };
  imports: string[];
}

interface RepoCacheEntry {
  files: Record<string, CachedFile>;
  importGraph: Record<string, string[]>;
  createdAt: number;
  lastAccessed: number;
}

export interface RepoCacheEntryWithMap {
  files: Map<string, CachedFile>;
  importGraph: Record<string, string[]>;
  createdAt: number;
}

interface EmbeddingEntry {
  embeddings: { path: string; embedding: number[] }[];
  createdAt: number;
  lastAccessed: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const TTL_MS = 10 * 60 * 1000;
const CACHE_DIR = path.join(os.tmpdir(), "repoorbit-cache");

// ─── In-memory hot cache (survives across calls within the same process) ──────
// Stores the deserialized entry so repeated reads never hit disk or JSON.parse

const hotCache = new Map<string, RepoCacheEntry & { _hydratedAt: number }>();
const hotEmbedCache = new Map<
  string,
  EmbeddingEntry & { _hydratedAt: number }
>();

// Debounced lastAccessed writes — batch disk updates every 30s instead of per-call
const pendingAccessUpdates = new Set<string>();
let accessFlushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAccessFlush() {
  if (accessFlushTimer) return;
  accessFlushTimer = setTimeout(async () => {
    accessFlushTimer = null;
    const keys = [...pendingAccessUpdates];
    pendingAccessUpdates.clear();
    await Promise.all(keys.map(flushAccessUpdate));
  }, 30_000);
}

async function flushAccessUpdate(repoFullName: string) {
  try {
    const filePath = getFileCachePath(repoFullName);
    if (!fs.existsSync(filePath)) return;
    // Only update the lastAccessed field — avoid full re-serialize
    // by patching the raw JSON string at the tail
    const raw = await fsp.readFile(filePath, "utf-8");
    const patched = raw.replace(
      /"lastAccessed":\d+/,
      `"lastAccessed":${Date.now()}`,
    );
    await fsp.writeFile(filePath, patched, "utf-8");
  } catch {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getFileCachePath(repoFullName: string): string {
  return path.join(CACHE_DIR, repoFullName.replace(/\//g, "__") + ".json");
}

function getEmbedCachePath(repoFullName: string): string {
  return path.join(
    CACHE_DIR,
    repoFullName.replace(/\//g, "__") + ".embeddings.json",
  );
}

function isExpired(lastAccessed: number): boolean {
  return Date.now() - lastAccessed > TTL_MS;
}

// ─── In-memory write buffer (used during indexing only) ───────────────────────

const writeBuffer = new Map<string, RepoCacheEntry>();

// ─── File Cache ───────────────────────────────────────────────────────────────

export function bufferCachedFile(repoFullName: string, file: CachedFile) {
  let entry = writeBuffer.get(repoFullName);
  if (!entry) {
    const now = Date.now();
    entry = { files: {}, importGraph: {}, createdAt: now, lastAccessed: now };
    writeBuffer.set(repoFullName, entry);
  }
  entry.files[file.path] = file;
  entry.importGraph[file.path] = file.imports;
}

export async function flushCachedRepo(repoFullName: string) {
  const entry = writeBuffer.get(repoFullName);
  if (!entry) return;

  ensureCacheDir();
  entry.lastAccessed = Date.now();

  const filePath = getFileCachePath(repoFullName);

  // Write to disk asynchronously
  await fsp.writeFile(filePath, JSON.stringify(entry), "utf-8");

  // Promote into hot cache so subsequent reads are instant
  hotCache.set(repoFullName, { ...entry, _hydratedAt: Date.now() });

  writeBuffer.delete(repoFullName);
}

export function getCachedFiles(
  repoFullName: string,
): RepoCacheEntryWithMap | null {
  // 1. Check write buffer first (indexing in progress)
  const buffered = writeBuffer.get(repoFullName);
  if (buffered) {
    return {
      files: new Map(Object.entries(buffered.files)),
      importGraph: buffered.importGraph,
      createdAt: buffered.createdAt,
    };
  }

  // 2. Check hot in-memory cache — zero disk I/O
  const hot = hotCache.get(repoFullName);
  if (hot) {
    if (isExpired(hot.lastAccessed)) {
      hotCache.delete(repoFullName);
      clearCachedRepo(repoFullName);
      return null;
    }
    // Bump in-memory lastAccessed immediately; debounce the disk write
    hot.lastAccessed = Date.now();
    pendingAccessUpdates.add(repoFullName);
    scheduleAccessFlush();
    return {
      files: new Map(Object.entries(hot.files)),
      importGraph: hot.importGraph,
      createdAt: hot.createdAt,
    };
  }

  // 3. Cold read from disk (only on first access after process start)
  try {
    const filePath = getFileCachePath(repoFullName);
    if (!fs.existsSync(filePath)) return null;

    const entry: RepoCacheEntry = JSON.parse(
      fs.readFileSync(filePath, "utf-8"),
    );

    if (isExpired(entry.lastAccessed ?? entry.createdAt)) {
      clearCachedRepo(repoFullName);
      return null;
    }

    // Promote into hot cache so this is the only cold read
    hotCache.set(repoFullName, { ...entry, _hydratedAt: Date.now() });
    pendingAccessUpdates.add(repoFullName);
    scheduleAccessFlush();

    return {
      files: new Map(Object.entries(entry.files)),
      importGraph: entry.importGraph,
      createdAt: entry.createdAt,
    };
  } catch {
    return null;
  }
}

export function clearCachedRepo(repoFullName: string) {
  writeBuffer.delete(repoFullName);
  hotCache.delete(repoFullName);
  pendingAccessUpdates.delete(repoFullName);
  try {
    const fp = getFileCachePath(repoFullName);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}
  clearCachedEmbeddings(repoFullName);
}

/**
 * Clear only the file/import cache, preserving embeddings.
 * Use this at the start of re-indexing — embeddings are expensive to rebuild
 * and stay valid as long as the file set hasn't changed substantially.
 */
export function clearFileCache(repoFullName: string) {
  writeBuffer.delete(repoFullName);
  hotCache.delete(repoFullName);
  pendingAccessUpdates.delete(repoFullName);
  try {
    const fp = getFileCachePath(repoFullName);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}
}

export function getCacheStats(repoFullName: string) {
  const buffered = writeBuffer.get(repoFullName);
  if (buffered) {
    return {
      fileCount: Object.keys(buffered.files).length,
      createdAt: buffered.createdAt,
      ageMs: Date.now() - buffered.createdAt,
      status: "buffering",
    };
  }

  const hot = hotCache.get(repoFullName);
  if (hot) {
    return {
      fileCount: Object.keys(hot.files).length,
      createdAt: hot.createdAt,
      lastAccessed: hot.lastAccessed,
      ageMs: Date.now() - hot.lastAccessed,
      status: isExpired(hot.lastAccessed) ? "expired" : "hot",
    };
  }

  try {
    const filePath = getFileCachePath(repoFullName);
    if (!fs.existsSync(filePath)) return null;
    const entry: RepoCacheEntry = JSON.parse(
      fs.readFileSync(filePath, "utf-8"),
    );
    return {
      fileCount: Object.keys(entry.files).length,
      createdAt: entry.createdAt,
      lastAccessed: entry.lastAccessed ?? entry.createdAt,
      ageMs: Date.now() - (entry.lastAccessed ?? entry.createdAt),
      status: isExpired(entry.lastAccessed ?? entry.createdAt)
        ? "expired"
        : "flushed",
    };
  } catch {
    return null;
  }
}

// ─── Embedding Cache ──────────────────────────────────────────────────────────

export function getCachedEmbeddings(
  repoFullName: string,
): { path: string; embedding: number[] }[] | null {
  // Check hot embed cache first
  const hot = hotEmbedCache.get(repoFullName);
  if (hot) {
    if (isExpired(hot.lastAccessed)) {
      hotEmbedCache.delete(repoFullName);
      clearCachedEmbeddings(repoFullName);
      return null;
    }
    hot.lastAccessed = Date.now();
    return hot.embeddings;
  }

  try {
    const filePath = getEmbedCachePath(repoFullName);
    if (!fs.existsSync(filePath)) return null;

    const entry: EmbeddingEntry = JSON.parse(
      fs.readFileSync(filePath, "utf-8"),
    );

    if (isExpired(entry.lastAccessed ?? entry.createdAt)) {
      clearCachedEmbeddings(repoFullName);
      return null;
    }

    // Promote to hot cache
    hotEmbedCache.set(repoFullName, { ...entry, _hydratedAt: Date.now() });

    return entry.embeddings;
  } catch {
    return null;
  }
}

export async function saveCachedEmbeddings(
  repoFullName: string,
  embeddings: { path: string; embedding: number[] }[],
) {
  try {
    ensureCacheDir();
    const now = Date.now();
    const entry: EmbeddingEntry = {
      embeddings,
      createdAt: now,
      lastAccessed: now,
    };
    // Async write — don't block the caller
    await fsp.writeFile(
      getEmbedCachePath(repoFullName),
      JSON.stringify(entry),
      "utf-8",
    );
    // Promote to hot cache immediately
    hotEmbedCache.set(repoFullName, { ...entry, _hydratedAt: now });
  } catch (err) {
    console.error("Failed to save embeddings to disk:", err);
  }
}

export function clearCachedEmbeddings(repoFullName: string) {
  hotEmbedCache.delete(repoFullName);
  try {
    const fp = getEmbedCachePath(repoFullName);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}
}
