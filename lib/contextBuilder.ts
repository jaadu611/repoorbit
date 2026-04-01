import { mkdirSync } from "fs";
import { writeFile, readFile } from "fs/promises";
import { join } from "path";

const IMPORT_DEPTH = 99999;
const FILE_CHAR_LIMIT = 100_000;
const SPLIT_THRESHOLD_CHARS = 3_000;
const MIN_RELEVANCE_SCORE_GENERIC = 3;
const MIN_RELEVANCE_SCORE_TARGETED = 15;

type RepoLanguage = "c" | "web" | "go" | "rust" | "python" | "java" | "mixed";

function detectRepoLanguage(filesMetadata: any[]): RepoLanguage {
  const extCounts: Record<string, number> = {};
  for (const f of filesMetadata) {
    const ext = (f.path as string).split(".").pop()?.toLowerCase() ?? "";
    extCounts[ext] = (extCounts[ext] ?? 0) + 1;
  }
  const total = filesMetadata.length || 1;
  const pct = (ext: string) => ((extCounts[ext] ?? 0) / total) * 100;

  if (pct("c") + pct("h") > 20) return "c";
  if (pct("rs") > 15) return "rust";
  if (pct("go") > 15) return "go";
  if (pct("py") > 15) return "python";
  if (pct("java") + pct("kt") > 15) return "java";
  if (pct("ts") + pct("tsx") + pct("js") + pct("jsx") > 15) return "web";
  return "mixed";
}

const TIER2_WEB = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "svelte",
  "vue",
]);
const TIER2_SYSTEMS = new Set([
  "c",
  "h",
  "cpp",
  "cc",
  "cxx",
  "hpp",
  "hxx",
  "rs",
  "go",
  "py",
  "rb",
  "java",
  "kt",
  "swift",
  "cs",
  "sh",
  "bash",
  "zsh",
  "sql",
  "S",
  "ld",
]);
const KERNEL_CONFIG_EXTENSIONS = new Set(["Kconfig", "Makefile", "makefile"]);

const TIER3_EXTENSIONS = new Set([
  "md",
  "mdx",
  "rst",
  "html",
  "yaml",
  "yml",
  "toml",
]);
const TIER4_EXTENSIONS = new Set(["css", "scss", "sass", "less"]);

const ROOT_CONFIG_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "jsconfig.json",
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "makefile",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".eslintrc.json",
  ".eslintrc.js",
  "eslint.config.js",
  "eslint.config.mjs",
  ".prettierrc",
  ".prettierrc.json",
  "prettier.config.js",
  "vite.config.ts",
  "vite.config.js",
  "next.config.ts",
  "next.config.js",
  "rollup.config.js",
  "webpack.config.js",
  "babel.config.js",
  "babel.config.json",
  "jest.config.ts",
  "jest.config.js",
  "vitest.config.ts",
  "vitest.config.ts",
  "tailwind.config.ts",
  "tailwind.config.js",
  "turbo.json",
  ".env.example",
  ".env.sample",
  "kconfig",
  "configure.ac",
  "configure",
  "cmakelists.txt",
  "meson.build",
  "build.ninja",
]);

const SOURCE_EXTENSIONS = new Set([
  ...TIER2_WEB,
  ...TIER2_SYSTEMS,
  ...TIER3_EXTENSIONS,
  ...TIER4_EXTENSIONS,
  "json",
  "toml",
]);

const EXCLUDE_PATTERNS: RegExp[] = [
  /node_modules/,
  /\.git\//,
  /dist\//,
  /\.next\//,
  /\.nuxt\//,
  /build\//,
  /coverage\//,
  /\.turbo\//,
  /\.cache\//,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.d\.(ts|mts|cts)$/,
  /vmlinux/,
  /\.ko$/,
  /\.o$/,
  /\.a$/,
  /tags$/,
  /TAGS$/,
];

const STOP_WORDS = new Set([
  "what",
  "does",
  "this",
  "that",
  "the",
  "how",
  "many",
  "times",
  "which",
  "file",
  "files",
  "where",
  "find",
  "show",
  "list",
  "have",
  "been",
  "there",
  "into",
  "from",
  "with",
  "about",
  "used",
  "called",
  "imported",
  "exported",
  "defined",
  "function",
  "method",
  "class",
  "module",
  "every",
  "each",
  "all",
  "any",
  "some",
  "repo",
  "code",
  "project",
  "codebase",
  "library",
  "package",
  "tell",
  "give",
  "return",
  "returns",
  "takes",
  "accepts",
  "throws",
  "emits",
  "renders",
  "works",
]);

type ImportRole = "Entry Point" | `Depth ${number}` | "Utility";
type QueryIntent =
  | "contributors"
  | "commits"
  | "branches"
  | "issues"
  | "pulls"
  | "repo_meta"
  | "tree"
  | "code"
  | "test";
type CodeFocus = "targeted" | "generic";

interface FunctionBlock {
  name: string;
  startLine: number;
  endLine: number;
  text: string;
}

interface ScoredFile {
  file: any;
  score: number;
}

interface Block {
  group: string;
  text: string;
  filePath?: string;
}

export interface ExpertPlan {
  files?: string[];
  intents?: QueryIntent[];
  focus?: CodeFocus;
}

const LINUX_SUBSYSTEMS: Record<string, string> = {
  arch: "arch",
  block: "block",
  certs: "certs",
  crypto: "crypto",
  Documentation: "docs",
  drivers: "drivers",
  fs: "fs",
  include: "include",
  init: "init",
  io_uring: "io_uring",
  ipc: "ipc",
  kernel: "kernel",
  lib: "lib",
  mm: "mm",
  net: "net",
  samples: "samples",
  scripts: "scripts",
  security: "security",
  sound: "sound",
  tools: "tools",
  usr: "usr",
  virt: "virt",
};

function subsystemKey(filePath: string): string {
  const first = filePath.split("/")[0];
  return LINUX_SUBSYSTEMS[first] ?? first ?? "_root";
}

function detectIntent(query: string): QueryIntent[] {
  const intents = new Set<QueryIntent>();
  const q = query.toLowerCase();

  if (/commit|contributed|push(ed)?/i.test(q)) intents.add("commits");
  if (/contribut(or|er|ion)|who (made|wrote|built|coded)|most active/i.test(q))
    intents.add("contributors");
  if (/branch(es)?|protected branch|default branch/i.test(q))
    intents.add("branches");
  if (/\bissue\b|bug report|ticket|open problem/i.test(q))
    intents.add("issues");
  if (/pull request|\bpr\b|merged?|code review/i.test(q)) intents.add("pulls");

  if (
    /\bstar|fork|licen[sc]e|topic|language|tech stack|docker|tailwind|\bci\b|readme/i.test(
      q,
    ) ||
    /\b(about|overview|purpose|summary|describe|description)\b/i.test(q) ||
    /what (is|are|does) (this|the) (repo|project|codebase|library|package|app)/i.test(
      q,
    ) ||
    /tell me about (this|the) (repo|project|codebase)/i.test(q) ||
    /^(what|describe|summarize|explain)\b.{0,60}$/i.test(q) ||
    /what does (this|the) repo (use|have|include|contain)/i.test(q) ||
    /does (this|the) (repo|project).{0,40}(use|have|include|support)/i.test(
      q,
    ) ||
    /is there (a|an).{0,40}(config|setup|file|docker|ci|test)/i.test(q) ||
    /what.{0,20}(framework|library|tool|stack|bundler|linter)/i.test(q)
  )
    intents.add("repo_meta");

  if (
    /^(list|show|what('s| is| are)?).{0,40}(file|folder|director|structure|tree|root)/i.test(
      q,
    ) ||
    /contents? of\s+[\w/.]+/i.test(q)
  )
    intents.add("tree");

  if (
    /\btest(s|ing|ed)?\b|\bspec\b|\bsuite\b|\bit\(|describe\(|jest|vitest|mocha|cypress/i.test(
      q,
    ) ||
    /show.{0,30}test|find.{0,30}test|where.{0,30}test/i.test(q)
  )
    intents.add("test");

  if (
    /what (changed|was (changed|updated|modified|added|removed))/i.test(q) ||
    /latest (change|update|commit|diff)/i.test(q) ||
    /recent (change|update|commit)/i.test(q)
  )
    intents.add("commits");

  const hasNonCodeIntent =
    intents.has("repo_meta") ||
    intents.has("contributors") ||
    intents.has("commits") ||
    intents.has("branches") ||
    intents.has("issues") ||
    intents.has("pulls") ||
    intents.has("tree");

  const hasCodeKeyword =
    /how (does|do|is|are|works?)|implement|function|method|class|module|export|import|call(ed)?|logic|algorithm|where is|defined?|which files?|involved|used by|source|syscall|subsystem|layer|driver|kernel|hook|handler|callback|irq|interrupt|vfs|inode|page|cache|scheduler|mm|net|block|fs/i.test(
      q,
    );
  const hasCamelSymbol = /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]+\b/.test(query);
  const hasSnakeSymbol = /\b[a-z][a-z0-9]*(_[a-z0-9]+){2,}\b/.test(query);
  const hasQuotedSymbol = /['"`]([a-zA-Z_$][a-zA-Z0-9_$]{2,})['"`]/.test(query);
  const hasFilePath = /\b[\w-]+\/[\w-]+(\.[a-z]{1,5})?\b/.test(query);

  if (intents.has("test")) intents.add("code");
  if (
    !hasNonCodeIntent ||
    hasCodeKeyword ||
    hasCamelSymbol ||
    hasSnakeSymbol ||
    hasQuotedSymbol ||
    hasFilePath
  ) {
    intents.add("code");
  }

  return [...intents];
}

function detectCodeFocus(query: string): CodeFocus {
  const q = query.toLowerCase();
  const isBroadQuestion =
    /how does .{0,40} (work|fit|connect|relate|interact)/i.test(q) ||
    /explain (the |how |what ).{0,60}/i.test(q) ||
    /walk me through/i.test(q) ||
    /architecture|overview|structure|system|pipeline|flow|subsystem|layer/i.test(
      q,
    );
  if (isBroadQuestion) return "generic";

  const hasSymbol =
    /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/.test(query) ||
    /\b[a-z][a-z0-9]*(_[a-z0-9]+){2,}\b/.test(query) ||
    /['"`]([a-zA-Z_$][a-zA-Z0-9_$]{2,})['"`]/.test(query);
  const hasFilePath = /\b[\w-]+\/[\w-]+(\.[a-z]{1,5})?\b/.test(query);
  const hasFocusedVerb =
    /what does .{0,60} (do|return|take|accept|throw|emit|render)/i.test(q) ||
    /how (does|is) .{0,60} (work|called|used|imported|exported|defined)/i.test(
      q,
    ) ||
    /where is .{0,60} (defined|used|called|imported|exported)/i.test(q) ||
    /how many times.{0,60}(import|call|use|invoke)/i.test(q) ||
    /which files?.{0,40}(import|use|call|depend)/i.test(q) ||
    /find (all|every|the).{0,40}(usage|import|call|reference|occurrence)/i.test(
      q,
    ) ||
    /show (me )?(all |every )?(usage|import|call|where)/i.test(q);

  return hasSymbol || hasFilePath || hasFocusedVerb ? "targeted" : "generic";
}

function extractQueryTokens(query: string): string[] {
  const tokens = new Set<string>();

  for (const q of query.match(/['"`]([a-zA-Z_$][a-zA-Z0-9_$]{2,})['"`]/g) ?? [])
    tokens.add(q.replace(/['"`]/g, ""));

  for (const p of query.match(/\b[\w-]+\/[\w-]+(\.[a-z]{1,5})?\b/g) ?? [])
    tokens.add(p);

  for (const chain of query.match(/\b[a-zA-Z_$][a-zA-Z0-9_$.]{3,}\b/g) ?? []) {
    if (chain.includes(".")) {
      tokens.add(chain);
      for (const part of chain.split("."))
        if (part.length > 2) tokens.add(part);
    }
  }

  for (const c of query.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g) ?? [])
    tokens.add(c);
  for (const s of query.match(/\b[a-z][a-z0-9]*(_[a-z0-9]+){1,}\b/g) ?? [])
    tokens.add(s);

  for (const w of query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/))
    if (w.length >= 2 && !STOP_WORDS.has(w)) tokens.add(w);

  return [...tokens];
}

function extractCSymbols(content: string): string[] {
  const syms = new Set<string>();

  for (const m of content.matchAll(
    /^[\w\s\*]+?\b([a-zA-Z_]\w*)\s*\([^;]*?\)\s*\{/gm,
  )) {
    const name = m[1];
    if (
      name &&
      name.length > 2 &&
      !["if", "for", "while", "switch", "return", "sizeof"].includes(name)
    ) {
      syms.add(name);
    }
  }

  for (const m of content.matchAll(
    /\b(struct|union|enum|typedef)\s+([a-zA-Z_]\w*)\b/g,
  )) {
    if (m[2]) syms.add(m[2]);
  }

  // Kernel specific: EXPORT_SYMBOL, #define
  for (const m of content.matchAll(/^#\s*define\s+([a-zA-Z_]\w*)/gm)) {
    if (m[1]) syms.add(m[1]);
  }

  for (const m of content.matchAll(
    /EXPORT_SYMBOL(?:_GPL)?\s*\(\s*([a-zA-Z_]\w*)\s*\)/g,
  )) {
    if (m[1]) syms.add(m[1]);
  }

  return [...syms];
}

// ─── C call-graph extraction ──────────────────────────────────────────────────

function buildCIncludeGraph(filesMetadata: any[]): Record<string, string[]> {
  const pathIndex = new Map<string, string>();
  for (const f of filesMetadata) {
    const base = (f.path as string).split("/").pop() ?? "";
    pathIndex.set(base, f.path);
  }

  const graph: Record<string, string[]> = {};
  for (const f of filesMetadata) {
    const content = safeContent(f);
    const deps: string[] = [];
    for (const m of content.matchAll(/^#\s*include\s+"([^"]+)"/gm)) {
      const inc = m[1];
      const base = inc.split("/").pop() ?? "";
      const resolved = pathIndex.get(base);
      if (resolved && resolved !== f.path) deps.push(resolved);
    }
    if (deps.length) graph[f.path] = deps;
  }
  return graph;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scoreFile(
  file: any,
  tokens: string[],
  importGraph: Record<string, string[]>,
  cIncludeGraph: Record<string, string[]>,
  isImportQuery: boolean,
  isTestQuery: boolean,
  lang: RepoLanguage,
): number {
  if (!tokens.length) return 0;

  let score = 0;
  const filePath = (file.path as string).toLowerCase();
  const exports: string[] = file.analysis?.exports ?? [];
  const imports: string[] = file.imports ?? [];
  const isTestFile =
    /\.(test|spec)\.[a-z]+$/.test(file.path) ||
    /__tests__/.test(file.path) ||
    /\/tests?\//.test(file.path);

  if (isTestFile && !isTestQuery) score -= 15;
  if (!isTestFile && isTestQuery) score -= 5;

  const content = safeContent(file);
  const fullContent = content.toLowerCase();

  const cSymbols =
    lang === "c" || lang === "mixed"
      ? extractCSymbols(content).map((s) => s.toLowerCase())
      : [];

  for (const token of tokens) {
    const t = token.toLowerCase();
    const pathBase =
      filePath
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? "";

    if (pathBase === t) score += 30;
    else if (filePath.includes(t)) score += 5;

    if (exports.some((e) => e.toLowerCase() === t)) score += 20;
    else if (exports.some((e) => e.toLowerCase().includes(t))) score += 8;

    if (imports.some((i) => i.toLowerCase().includes(t))) score += 3;

    if (cSymbols.includes(t)) score += 20;
    else if (cSymbols.some((s) => s.includes(t))) score += 8;

    const occurrences = (
      fullContent.match(new RegExp(`\\b${escapeRegex(t)}\\b`, "g")) ?? []
    ).length;
    score += Math.min(occurrences * 2, 30);

    if (token.includes("/") && filePath.includes(t)) score += 50;
  }

  if (isImportQuery) {
    const jsImporterCount = Object.values(importGraph).filter((deps) =>
      deps.some((d) => d.includes(file.path) || file.path.includes(d)),
    ).length;
    score += jsImporterCount * 4;

    const cIncluderCount = Object.values(cIncludeGraph).filter((deps) =>
      deps.includes(file.path),
    ).length;
    score += cIncluderCount * 4;
  }

  if ((file.metrics?.codeLines ?? 0) < 5) score = Math.floor(score * 0.4);

  const fileName = file.path.split("/").pop() ?? "";
  if (fileName.startsWith("Kconfig")) score += 10;
  if (fileName === "Makefile" || fileName === "makefile") score += 5;
  if (file.path.endsWith(".S")) score += 8;

  return score;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── File selection ───────────────────────────────────────────────────────────

function selectFilesForQuery(
  sourceFiles: any[],
  query: string,
  focus: CodeFocus,
  importGraph: Record<string, string[]>,
  cIncludeGraph: Record<string, string[]>,
  depthMap: Map<string, number>,
  intents: QueryIntent[],
  lang: RepoLanguage,
): { files: any[]; omittedCount: number; omittedPaths: string[] } {
  if (focus === "generic" && !intents.includes("code")) {
    return { files: [], omittedCount: sourceFiles.length, omittedPaths: [] };
  }

  const tokens = extractQueryTokens(query);
  if (tokens.length === 0 && focus === "targeted") focus = "generic";

  const isImportQuery =
    /how many times|import(ed)?|usage|reference|occurrence|depend|include/i.test(
      query,
    );
  const isTestQuery = intents.includes("test");

  const threshold =
    focus === "targeted"
      ? MIN_RELEVANCE_SCORE_TARGETED
      : MIN_RELEVANCE_SCORE_GENERIC;

  const scored: { file: any; score: number }[] = sourceFiles.map((file) => ({
    file,
    score: scoreFile(
      file,
      tokens,
      importGraph,
      cIncludeGraph,
      isImportQuery,
      isTestQuery,
      lang,
    ),
  }));

  // ─── Phase 2: Reverse-Dependency Lookback (Caller-Context Snapping) ───
  const highSignalTargets = scored.filter(
    (c) => c.score >= MIN_RELEVANCE_SCORE_TARGETED,
  );
  const targetSymbols = new Set<string>();

  for (const target of highSignalTargets) {
    const exports = target.file.analysis?.exports ?? [];
    exports.forEach((e: string) => targetSymbols.add(e));
    if (lang === "c" || lang === "mixed") {
      extractCSymbols(safeContent(target.file)).forEach((s) =>
        targetSymbols.add(s),
      );
    }
  }

  const statefulPatterns = [
    /\.map\(/,
    /\.forEach\(/,
    /\.reduce\(/,
    /\bwhile\b/,
    /list_for_each/,
    /\.(push|add|insert|append)\(/,
    /\.id\s*==/,
  ];

  if (targetSymbols.size > 0) {
    for (const candidate of scored) {
      if (candidate.score >= MIN_RELEVANCE_SCORE_TARGETED) continue;

      const content = safeContent(candidate.file);
      const foundSymbols = [...targetSymbols].filter((sym) =>
        new RegExp(`\\b${escapeRegex(sym)}\\b`).test(content),
      );

      if (foundSymbols.length > 0) {
        const isStatefulCall = statefulPatterns.some((pattern) =>
          pattern.test(content),
        );
        if (isStatefulCall) {
          candidate.score += 25;
          (candidate.file as any).snapSymbols = foundSymbols;
        }
      }
    }
  }

  // ─── Phase 3: Shadow Context (Consumer Pulling) ───
  for (const target of highSignalTargets) {
    const targetPath = target.file.path;
    const consumers = scored.filter((c) => {
      const deps = importGraph[c.file.path] || cIncludeGraph[c.file.path] || [];
      return deps.some((d) => d.includes(targetPath) || targetPath.includes(d));
    });

    for (const consumer of consumers) {
      if (consumer.score >= threshold) continue;
      const content = safeContent(consumer.file);
      // High-density logic check: presence of conditionals/loops AND variable assignments
      if (
        /\b(if|while|for|switch|case)\b/.test(content) &&
        content.includes("=")
      ) {
        consumer.score += 20;
        (consumer.file as any).isShadowContext = true;
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const relevant = scored.filter((s) => s.score >= threshold);
  const selected = relevant.map((s) => s.file);
  const omitted = scored
    .filter((s) => !selected.includes(s.file))
    .map((s) => s.file);

  return {
    files: selected,
    omittedCount: omitted.length,
    omittedPaths: omitted.slice(0, 20).map((f) => f.path),
  };
}

// ─── Import depth resolution ──────────────────────────────────────────────────

function resolveImportDepths(
  seedPaths: string[],
  importGraph: Record<string, string[]>,
  maxDepth: number,
): Map<string, number> {
  const depths = new Map<string, number>();
  for (const seed of seedPaths) depths.set(seed, 0);
  let frontier = [...seedPaths];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const dep of importGraph[p] ?? []) {
        if (!depths.has(dep)) {
          depths.set(dep, depth);
          next.push(dep);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return depths;
}

function importRoleLabel(depth: number | undefined): ImportRole {
  if (depth === undefined) return "Utility";
  if (depth === 0) return "Entry Point";
  return `Depth ${depth}`;
}

// ─── File tier ────────────────────────────────────────────────────────────────

function fileTier(filePath: string, lang: RepoLanguage = "web"): number {
  if (EXCLUDE_PATTERNS.some((re) => re.test(filePath))) return 0;

  const parts = filePath.split("/");
  const fileName = parts[parts.length - 1];
  const fileNameLower = fileName.toLowerCase();
  const ext = fileName.split(".").pop() ?? "";
  const extLower = ext.toLowerCase();

  if (
    fileName === "Kconfig" ||
    fileName.startsWith("Kconfig.") ||
    KERNEL_CONFIG_EXTENSIONS.has(fileName)
  )
    return 1;

  if (extLower === "ld" || extLower === "lds") return 2;
  if (ext === "S") return 2;

  const isRoot = parts.length === 1;
  const isShallowDoc =
    parts.length <= 2 &&
    (extLower === "md" || extLower === "mdx" || extLower === "rst");
  const isKeyConfig = isRoot && ROOT_CONFIG_NAMES.has(fileNameLower);
  const isGitHubWorkflow = /^\.github\/workflows\//.test(filePath);
  if (isRoot || isShallowDoc || isKeyConfig || isGitHubWorkflow) return 1;

  if (
    TIER2_WEB.has(extLower) ||
    TIER2_SYSTEMS.has(ext) ||
    TIER2_SYSTEMS.has(extLower)
  )
    return 2;

  if (
    extLower === "md" ||
    extLower === "mdx" ||
    extLower === "rst" ||
    extLower === "html" ||
    extLower === "yaml" ||
    extLower === "yml" ||
    extLower === "toml" ||
    extLower === "json"
  )
    return 3;

  if (TIER4_EXTENSIONS.has(extLower)) return 4;

  return 0;
}

function shouldInclude(filePath: string, lang: RepoLanguage = "web"): boolean {
  return fileTier(filePath, lang) > 0;
}

// ─── Budget-aware file selection ──────────────────────────────────────────────

function selectFilesByBudget(
  candidates: any[],
  estimateWords: (f: any) => number,
  lang: RepoLanguage,
): { files: any[]; droppedTiers: number[] } {
  const withTier = candidates
    .map((f) => ({ file: f, tier: fileTier(f.path, lang) }))
    .filter((x) => x.tier > 0);

  const mustInclude = withTier.filter((x) => x.tier <= 2).map((x) => x.file);
  const tier3 = withTier.filter((x) => x.tier === 3).map((x) => x.file);
  const tier4 = withTier.filter((x) => x.tier === 4).map((x) => x.file);

  const HARD_WORD_CEILING = 1_000_000_000;
  const wordsOf = (files: any[]) =>
    files.reduce((s, f) => s + estimateWords(f), 0);
  const droppedTiers: number[] = [];

  let selected = [...mustInclude, ...tier3, ...tier4];
  if (wordsOf(selected) > HARD_WORD_CEILING) {
    selected = [...mustInclude, ...tier3];
    droppedTiers.push(4);
  }
  if (wordsOf(selected) > HARD_WORD_CEILING) {
    selected = [...mustInclude];
    droppedTiers.push(3);
  }

  return { files: selected, droppedTiers };
}

// ─── Doc detection ────────────────────────────────────────────────────────────

function isDocFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (ext !== "md" && ext !== "mdx" && ext !== "rst") return false;
  return !/node_modules|CHANGELOG|CHANGES|HISTORY|\.github\/|dist\//.test(
    filePath,
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeFileExt(file: any): string {
  const raw: unknown = file.ext;
  if (typeof raw !== "string" || raw.includes("."))
    return (file.path as string).split(".").pop()?.toLowerCase() ?? "";
  return raw.toLowerCase();
}

function safeContent(file: any): string {
  if (!file) return "";
  const c = file.content || file.analysis?.fullContent;
  if (!c) return "";
  return String(c);
}

// ─── Directory structure ──────────────────────────────────────────────────────

function getDirectoryStructure(
  filesMetadata: any[],
  lang: RepoLanguage,
  maxLines = 400,
): string {
  const included = filesMetadata.filter((f) => shouldInclude(f.path, lang));

  type TreeNode = { files: string[]; children: Map<string, TreeNode> };
  const root: TreeNode = { files: [], children: new Map() };

  for (const file of included) {
    const parts = (file.path as string).split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!node.children.has(seg))
        node.children.set(seg, { files: [], children: new Map() });
      node = node.children.get(seg)!;
    }
    node.files.push(parts[parts.length - 1]);
  }

  const lines: string[] = [];
  let lineCount = 0;
  let truncated = false;

  function countFiles(node: TreeNode): number {
    return (
      node.files.length +
      [...node.children.values()].reduce((s, c) => s + countFiles(c), 0)
    );
  }

  function render(node: TreeNode, indent: number) {
    if (lineCount >= maxLines) {
      truncated = true;
      return;
    }
    for (const f of node.files.sort()) {
      if (lineCount >= maxLines) {
        truncated = true;
        return;
      }
      lines.push(`${" ".repeat(indent)}${f}`);
      lineCount++;
    }
    for (const [seg, child] of [...node.children.entries()].sort()) {
      if (lineCount >= maxLines) {
        truncated = true;
        return;
      }
      const count = countFiles(child);
      lines.push(
        `${" ".repeat(indent)}${seg}/  (${count} file${count !== 1 ? "s" : ""})`,
      );
      lineCount++;
      render(child, indent + 2);
    }
  }

  render(root, 0);
  if (truncated)
    lines.push(`\n[TRUNCATED: Directory listing exceeds ${maxLines} lines.]`);
  return lines.join("\n");
}

// ─── Repo metadata sections ───────────────────────────────────────────────────

function docSortKey(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower === "readme.md" || lower === "readme.mdx" || lower === "readme.rst")
    return "0-root-readme";
  if (!filePath.includes("/")) return `1-root-${lower}`;
  if (/^(docs?|wiki|documentation)\//.test(lower))
    return `2-docsfolder-${lower}`;
  return `3-other-${lower}`;
}

function getReadme(docFiles: any[], maxFiles = 5): string {
  if (!docFiles.length) return "";
  const sorted = [...docFiles].sort((a, b) =>
    docSortKey(a.path).localeCompare(docSortKey(b.path)),
  );
  const limited = sorted.slice(0, maxFiles);
  const omitted = sorted.length - limited.length;

  const parts: string[] = [
    `## Project Documentation\n\nIncluding ${limited.length} documentation file${limited.length !== 1 ? "s" : ""}.${omitted > 0 ? ` Omitted ${omitted} secondary doc files.` : ""}`,
  ];
  for (const doc of limited) {
    let content = safeContent(doc);
    if (content.length > FILE_CHAR_LIMIT) {
      const cut = content.lastIndexOf("\n", FILE_CHAR_LIMIT);
      content =
        content.slice(0, cut > 0 ? cut : FILE_CHAR_LIMIT) + `\n\n[TRUNCATED]`;
    }
    parts.push(`### ${doc.path}\n\n${content}`);
  }
  return parts.join("\n\n");
}

function getRepoMeta(repoContext: any, lang: RepoLanguage): string {
  const stack = repoContext?.stack ?? {};
  const meta = repoContext?.meta ?? {};
  const github = repoContext?.github ?? {};
  const stats = repoContext?.stats ?? {};
  const languages = repoContext?.languages ?? [];

  const topLangs =
    languages
      .slice(0, 5)
      .map((l: any) => `${l.lang} (${l.pct}%)`)
      .join(", ") || "unknown";
  const stackItems =
    [
      stack.hasTailwind ? "Tailwind CSS" : null,
      stack.hasDocker ? "Docker" : null,
      stack.hasTests ? "automated tests" : null,
      stack.hasGitActions ? "GitHub Actions CI" : null,
    ]
      .filter(Boolean)
      .join(", ") || "no detected tooling";

  const langNote =
    lang === "c"
      ? `\n\nThis is a C/systems codebase. Import graph is built from #include directives. Symbol extraction uses EXPORT_SYMBOL, struct, typedef, and function definition patterns.`
      : "";

  return `## Repository Overview

${meta.fullName ?? "Unknown repo"} is a ${stack.architecture ?? "unknown"} project. ${github.description ?? ""}

It has ${meta.stars ?? 0} stars, ${meta.forks ?? 0} forks, and ${meta.openIssues ?? 0} open issues. The license is ${meta.license ?? "unknown"}. The default branch is ${meta.defaultBranch ?? "unknown"}, last pushed on ${meta.pushedAt ?? "unknown"}.

Topics: ${github.topics?.join(", ") || "none listed"}. Primary languages: ${topLangs}. The stack includes: ${stackItems}.

The repository contains ${stats.totalFiles ?? "?"} files across ${stats.totalFolders ?? "?"} folders with a maximum directory depth of ${stats.maxDepth ?? "?"}.${langNote}`;
}

function getContributorsNames(repoContext: any): string {
  const contributors = repoContext?.contributors ?? [];
  if (!contributors.length) return "";
  const sorted = [...contributors].sort(
    (a: any, b: any) => b.contributions - a.contributions,
  );
  const list = sorted
    .map(
      (c: any, i: number) =>
        `${i + 1}. ${c.login} with ${c.contributions} commits`,
    )
    .join("\n");
  return `## Contributors\n\nTop contributor: ${sorted[0].login} with ${sorted[0].contributions} commits.\n\n${list}`;
}

function getCommitHistory(repoContext: any): string {
  const commitsByAuthor: Record<string, any[]> =
    repoContext?.commitsByAuthor ?? {};
  if (!Object.keys(commitsByAuthor).length) {
    if (!repoContext?.recentCommits?.length) return "";
    const lines = repoContext.recentCommits.map(
      (c: any) =>
        `- ${c.message.split("\n")[0]} by ${c.author} on ${c.date} [${c.shortSha}]`,
    );
    return `## Recent Commits\n\n${lines.join("\n")}`;
  }
  const parts: string[] = ["## Commit History"];
  // Sort authors for deterministic output
  for (const [author, commits] of Object.entries(commitsByAuthor).sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )) {
    const shown = (commits as any[]).slice(0, 20);
    const hidden = commits.length - shown.length;
    parts.push(
      `\n### Commits by ${author} (${commits.length} total${hidden > 0 ? `, ${hidden} older omitted` : ""})\n\n` +
        shown
          .map(
            (c: any) =>
              `- ${c.message?.split("\n")[0] ?? ""} on ${c.date} [${c.shortSha}]`,
          )
          .join("\n"),
    );
  }
  return parts.join("\n");
}

function getBranches(repoContext: any): string {
  const branches = repoContext?.branches ?? [];
  if (!branches.length) return "";
  return `## Branches\n\n${branches.map((b: any) => `- ${b.name}${b.protected ? " (protected)" : ""}`).join("\n")}`;
}

function getIssues(repoContext: any): string {
  const issues = repoContext?.issues ?? [];
  if (!issues.length) return "";
  const open = issues.filter((i: any) => i.state === "open").length;
  const closed = issues.filter((i: any) => i.state === "closed").length;
  const lines: string[] = [`## Issues (${open} open, ${closed} closed)\n`];
  for (const i of issues) {
    const labels = i.labels?.length ? ` Labels: ${i.labels.join(", ")}.` : "";
    lines.push(`### Issue #${i.number}: ${i.title} (${i.state})\n`);
    lines.push(
      `Opened by ${i.author ?? "unknown"} on ${i.createdAt}. ${i.comments} comment(s).${labels}`,
    );
    if (i.body)
      lines.push(
        `\n${i.body.slice(0, 400)}${i.body.length > 400 ? "..." : ""}`,
      );
  }
  return lines.join("\n");
}

function getPulls(repoContext: any): string {
  const pulls = repoContext?.pulls ?? [];
  if (!pulls.length) return "";
  const open = pulls.filter((p: any) => p.state === "open").length;
  const merged = pulls.filter((p: any) => p.merged).length;
  const lines: string[] = [
    `## Pull Requests (${open} open, ${merged} merged)\n`,
  ];
  for (const p of pulls) {
    lines.push(
      `### PR #${p.number}: ${p.title} (${p.merged ? "merged" : p.state})\n`,
    );
    lines.push(
      `Author: ${p.author ?? "unknown"}. Branch: ${p.headBranch} into ${p.baseBranch}. Opened: ${p.createdAt}.${p.mergedAt ? ` Merged: ${p.mergedAt}.` : ""}`,
    );
    if (p.body)
      lines.push(
        `\n${p.body.slice(0, 400)}${p.body.length > 400 ? "..." : ""}`,
      );
  }
  return lines.join("\n");
}

// ─── C include graph summary ──────────────────────────────────────────────────

function getCIncludeGraphSummary(
  cIncludeGraph: Record<string, string[]>,
  selectedFilePaths: Set<string>,
): string {
  // Sort keys for deterministic output
  const entries = Object.keys(cIncludeGraph)
    .sort()
    .filter((from) => selectedFilePaths.has(from))
    .map((from) => {
      const relevantDeps = cIncludeGraph[from]
        .filter((d) => selectedFilePaths.has(d))
        .sort();
      return relevantDeps.length
        ? `- ${from} includes: ${relevantDeps.join(", ")}`
        : null;
    })
    .filter(Boolean);

  if (!entries.length) return "";
  return `## C Include Graph (selected files)\n\nLocal #include relationships among included files:\n\n${entries.join("\n")}`;
}

// ─── Function block parsing ───────────────────────────────────────────────────

function parseFunctionBlocks(content: string): FunctionBlock[] {
  const lines = content.split("\n");
  const blocks: FunctionBlock[] = [];
  const startRe =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*(\w+)|class\s+(\w+)|const\s+(\w+)\s*=|let\s+(\w+)\s*=|var\s+(\w+)\s*=)/;
  const decoratorRe = /^@\w+/;

  let i = 0;
  while (i < lines.length) {
    let decoratorStart: number | null = null;
    while (i < lines.length && decoratorRe.test(lines[i].trim())) {
      if (decoratorStart === null) decoratorStart = i;
      i++;
    }
    const m = startRe.exec(lines[i]?.trim() ?? "");
    if (!m) {
      i++;
      continue;
    }

    const name = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "anonymous";
    const blockStart = decoratorStart ?? i;
    let depth = 0,
      hasOpenedBrace = false;
    let inString: string | null = null;
    let inTemplateBraceDepth = 0;
    let j = i;

    outer: while (j < lines.length) {
      const line = lines[j];
      let k = 0;
      while (k < line.length) {
        const ch = line[k];
        if (inString === "`") {
          if (ch === "\\") {
            k += 2;
            continue;
          }
          if (ch === "$" && line[k + 1] === "{") {
            inTemplateBraceDepth++;
            k += 2;
            continue;
          }
          if (ch === "{" && inTemplateBraceDepth > 0) {
            depth++;
            k++;
            continue;
          }
          if (ch === "}" && inTemplateBraceDepth > 0) {
            if (depth > 0) depth--;
            else inTemplateBraceDepth--;
            k++;
            continue;
          }
          if (ch === "`") {
            inString = null;
            k++;
            continue;
          }
        } else if (inString) {
          if (ch === "\\") {
            k += 2;
            continue;
          }
          if (ch === inString) inString = null;
        } else {
          if (ch === '"' || ch === "'") inString = ch;
          else if (ch === "`") inString = "`";
          else if (ch === "{") {
            depth++;
            hasOpenedBrace = true;
          } else if (ch === "}") {
            depth--;
            if (hasOpenedBrace && depth <= 0) {
              j++;
              break outer;
            }
          } else if (
            !hasOpenedBrace &&
            ch === "=" &&
            line[k + 1] === ">" &&
            j > i
          ) {
            j++;
            break outer;
          }
        }
        k++;
      }
      j++;
      if (!hasOpenedBrace && j > i + 3) break;
    }

    const endLine = j - 1;
    if (endLine > blockStart) {
      blocks.push({
        name,
        startLine: blockStart,
        endLine,
        text: lines.slice(blockStart, endLine + 1).join("\n"),
      });
    }
    i = j;
  }
  return blocks;
}

// ─── C function block parsing ─────────────────────────────────────────────────

function parseCFunctionBlocks(content: string): FunctionBlock[] {
  const lines = content.split("\n");
  const blocks: FunctionBlock[] = [];
  const defRe = /^[a-zA-Z_][\w\s\*]*\b(\w+)\s*\([^;]*$/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (
      !line ||
      line.startsWith("#") ||
      line.startsWith("//") ||
      line.startsWith("*") ||
      line.startsWith("/*")
    ) {
      i++;
      continue;
    }

    const m = defRe.exec(lines[i]);
    if (!m || lines[i].startsWith(" ") || lines[i].startsWith("\t")) {
      i++;
      continue;
    }

    const name = m[1];
    if (
      !name ||
      ["if", "for", "while", "switch", "else", "do", "return"].includes(name)
    ) {
      i++;
      continue;
    }

    let braceStart = i;
    while (
      braceStart < Math.min(i + 6, lines.length) &&
      !lines[braceStart].includes("{")
    )
      braceStart++;
    if (braceStart >= lines.length || !lines[braceStart].includes("{")) {
      i++;
      continue;
    }

    let depth = 0,
      j = braceStart,
      found = false;
    while (j < lines.length) {
      for (const ch of lines[j]) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            found = true;
            break;
          }
        }
      }
      if (found) break;
      j++;
    }

    if (found && j > i) {
      const text = lines.slice(i, j + 1).join("\n");
      const lineCount = j - i + 1;
      if (lineCount >= 3 && lineCount <= 500) {
        blocks.push({ name, startLine: i, endLine: j, text });
      }
    }

    i = found ? j + 1 : i + 1;
  }
  return blocks;
}

// ─── Universal Bracket Parser ───────────────────────────────────────────────────

function parseUniversalBlocks(content: string, ext: string): FunctionBlock[] {
  const lines = content.split("\n");
  const blocks: FunctionBlock[] = [];

  const isPython = ext === "py" || ext === "yml" || ext === "yaml";
  let inBlock = false;
  let blockStart = -1;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*")
    )
      continue;

    if (isPython) {
      const match = line.match(/^([ \t]*)(def|class)\s+(\w+)/);
      if (match && !inBlock) {
        const indent = match[1].length;
        const name = match[3];
        blockStart = i;
        inBlock = true;
        let j = i + 1;
        while (j < lines.length) {
          const l2 = lines[j];
          if (l2.trim() === "") {
            j++;
            continue;
          }
          const l2Indent = l2.match(/^[ \t]*/)?.[0].length ?? 0;
          if (l2Indent <= indent && !l2.trim().startsWith("#")) {
            break;
          }
          j++;
        }
        blocks.push({
          name,
          startLine: blockStart,
          endLine: j - 1,
          text: lines.slice(blockStart, j).join("\n"),
        });
        i = j - 1;
        inBlock = false;
      }
    } else {
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth--;
      }

      if (!inBlock && braceDepth > 0) {
        inBlock = true;
        blockStart = i;
      } else if (inBlock && braceDepth <= 0) {
        inBlock = false;
        if (i - blockStart >= 3) {
          blocks.push({
            name: `[Anonymous Block at Line ${blockStart + 1}]`,
            startLine: blockStart,
            endLine: i,
            text: lines.slice(blockStart, i + 1).join("\n"),
          });
        }
        braceDepth = 0;
      }
    }
  }
  return blocks;
}

function prioritizeBlocks(
  blocks: FunctionBlock[],
  lang: RepoLanguage = "mixed",
  snapSymbols: string[] = [],
): FunctionBlock[] {
  if (blocks.length <= 9 && snapSymbols.length === 0) return blocks;

  const logicKeywords = [
    "if",
    "while",
    "return",
    "await",
    "yield",
    "match",
    "case",
    "for",
    "switch",
    "list_for_each",
    "list_entry",
    "push",
    "reduce",
    "aggregate",
    "join",
    "groupby",
    "yield",
  ];

  const scoreBlock = (b: FunctionBlock) => {
    let score = 0;
    const words = b.text.split(/[^a-zA-Z_]/);
    for (const w of words) if (logicKeywords.includes(w)) score++;

    // Caller-Context Snapping (+50)
    if (snapSymbols.length > 0) {
      for (const sym of snapSymbols) {
        if (new RegExp(`\\b${escapeRegex(sym)}\\b`).test(b.text)) {
          score += 50;
        }
      }
    }

    // 1. Logic-Unit Bundling (+40)
    // Recognizes structural iterators that likely wrap target logic
    const hasControlFlowIterator = /\b(for|while|foreach|do)\s*\(/.test(b.text);
    const hasPythonComprehension = /\[.*\s+for\s+.*\s+in\s+.*\]/.test(b.text);
    const hasFunctionalIterator =
      /\.(map|reduce|filter|forEach|flatMap)\(/.test(b.text);

    if (
      snapSymbols.length > 0 &&
      (hasControlFlowIterator ||
        hasPythonComprehension ||
        hasFunctionalIterator)
    ) {
      // If this block is an iterator AND it contains a target symbol (already boosted by +50),
      // give it an extra "Logic-Unit" boost to ensure the entire wrapper is kept.
      score += 40;
    }

    // 2. State-Accumulator Heuristic (+25)
    // C/C++: Pointers/Arrays being filled
    const hasCPointerAccumulator =
      /\*\w+\+\+\s*=/.test(b.text) || /\w+\[\w+\]\s*=/.test(b.text);
    // Scripting: +=, .push, .append, dict[k] =
    const hasScriptAccumulator =
      /\+=/.test(b.text) ||
      /\.(push|append|add|insert|extend|update)\(/.test(b.text);

    if (hasCPointerAccumulator || hasScriptAccumulator) {
      score += 25;
    }

    // 3. Relational/Stateful Bonus (+15)
    const hasIdCheck =
      /\.id\s*==/.test(b.text) || /\b(PK|UUID|guid)\b/i.test(b.text);
    if (hasIdCheck && (hasScriptAccumulator || hasFunctionalIterator)) {
      score += 15;
    }

    return score;
  };

  const scored = blocks.map((b, idx) => ({
    block: b,
    score: scoreBlock(b),
    idx,
  }));

  const oneThird = Math.floor(scored.length / 3);
  const firstThird = scored
    .slice(0, oneThird)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const middleThird = scored
    .slice(oneThird, 2 * oneThird)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const lastThird = scored
    .slice(2 * oneThird)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const selected = [...firstThird, ...middleThird, ...lastThird]
    .sort((a, b) => a.idx - b.idx)
    .map((s) => s.block);
  return selected;
}

// ─── File context generation ──────────────────────────────────────────────────

function getFileContext(
  file: any,
  role: ImportRole,
  repoName: string,
  lang: RepoLanguage,
  notebookName = "",
  crossDeps: string[] = [],
): string {
  const ext = safeFileExt(file);
  const exports: string[] = file.analysis?.exports ?? [];
  const imports: string[] = file.imports ?? [];
  const todos: string[] = file.analysis?.todoComments ?? [];
  const lineCount = file.metrics?.lineCount ?? "?";
  const codeLines = file.metrics?.codeLines ?? "?";
  const logicType = file.analysis?.logicType ?? "unknown";
  const flags = [
    file.analysis?.isReact ? "React component" : "",
    file.analysis?.isTest ? "test file" : "",
  ]
    .filter(Boolean)
    .join(", ");

  const isCFile = [
    "c",
    "h",
    "cpp",
    "cc",
    "cxx",
    "hpp",
    "hxx",
    "S",
    "ld",
  ].includes(ext);

  let exportsStr: string;
  let exportsInfoStr: string;

  if (isCFile) {
    const symbols = extractCSymbols(safeContent(file));
    if (symbols.length) {
      const shown = symbols.slice(0, 30);
      const extra =
        symbols.length > 30 ? ` and ${symbols.length - 30} more` : "";
      exportsStr = `Symbols (functions, macros, structs, EXPORT_SYMBOL): ${shown.join(", ")}${extra}.`;
      exportsInfoStr = shown.join(", ") + extra;
    } else {
      exportsStr = "No detected public symbols.";
      exportsInfoStr = "(none detected)";
    }
  } else {
    if (exports.length) {
      exportsStr = `It exports: ${exports.join(", ")}.`;
      exportsInfoStr = exports.join(", ");
    } else {
      exportsStr = "It has no named exports.";
      exportsInfoStr = "(none)";
    }
  }

  const topImports = imports.slice(0, 12);
  const importsStr = imports.length
    ? `It imports from: ${topImports.join(", ")}${imports.length > 12 ? ` and ${imports.length - 12} more` : ""}.`
    : isCFile
      ? ""
      : "It has no imports.";
  const importsInfoStr = imports.length
    ? topImports.join(", ") +
      (imports.length > 12 ? ` and ${imports.length - 12} more` : "")
    : "(none)";

  const todosStr = todos.length ? ` TODOs: ${todos.join(" | ")}.` : "";
  const flagsStr = flags ? ` (${flags})` : "";

  const prose =
    `This file is a **${role}** in the ${repoName} ${isCFile ? "include" : "import"} graph${flagsStr}. ` +
    `Logic type: ${logicType}. ${lineCount} lines (${codeLines} code lines). ` +
    `${exportsStr}${importsStr ? " " + importsStr : ""}${todosStr}`;

  let content = safeContent(file);
  const isNonCodeFile = [
    "css",
    "scss",
    "sass",
    "less",
    "json",
    "yaml",
    "yml",
    "toml",
    "md",
    "mdx",
    "rst",
  ].includes(ext);

  const heading = `### ${file.path} (${role})`;

  const manifestSummaryLine = notebookName
    ? `> This file is part of **${notebookName}**. The local manifest (\`00_manifest.txt\`) lists all files in this notebook.`
    : "";

  const crossDepsInfoStr =
    crossDeps.length > 0 ? crossDeps.join("; ") : "(none in this file)";

  const fileInfoBlock = [
    `**File Information:**`,
    `- **Original path:** ${file.path}`,
    `- **Role:** ${role}`,
    `- **Exports:** ${exportsInfoStr}`,
    `- **Imports:** ${importsInfoStr}`,
    `- **Cross‑notebook dependencies:** ${crossDepsInfoStr}`,
  ].join("\n");

  const headerParts: string[] = [heading];
  if (manifestSummaryLine) headerParts.push("", manifestSummaryLine);
  headerParts.push("", fileInfoBlock, "", prose);

  if (content.length <= SPLIT_THRESHOLD_CHARS || isNonCodeFile) {
    if (content.length > FILE_CHAR_LIMIT && isNonCodeFile) {
      const cut = content.lastIndexOf("\n", FILE_CHAR_LIMIT);
      content =
        content.slice(0, cut > 0 ? cut : FILE_CHAR_LIMIT) +
        `\n\n[TRUNCATED: file exceeds ${FILE_CHAR_LIMIT.toLocaleString()} characters.]`;
    }
    return [...headerParts, "", `\`\`\`${ext}`, content, "```"].join("\n");
  }

  let blocks = isCFile
    ? parseCFunctionBlocks(content)
    : parseFunctionBlocks(content);

  if (blocks.length === 0 && !isNonCodeFile) {
    blocks = parseUniversalBlocks(content, ext);
  }

  const snapSymbols: string[] = file.snapSymbols ?? [];
  if (snapSymbols.length > 0) {
    blocks = prioritizeBlocks(blocks, lang, snapSymbols);
  }

  const originalFirstBlockLine = blocks.length > 0 ? blocks[0].startLine : 0;

  if (content.length > FILE_CHAR_LIMIT) {
    if (blocks.length === 0) {
      const len = content.length;
      const s1 = content.slice(0, Math.floor(len * 0.1));
      const s2 = content.slice(Math.floor(len * 0.4), Math.floor(len * 0.6));
      const s3 = content.slice(Math.floor(len * 0.9));
      content =
        s1 +
        "\n\n[... TRUNCATED SAMPLING WINDOW ...]\n\n" +
        s2 +
        "\n\n[... TRUNCATED SAMPLING WINDOW ...]\n\n" +
        s3;
      return [...headerParts, "", `\`\`\`${ext}`, content, "```"].join("\n");
    } else {
      blocks = prioritizeBlocks(blocks);
    }
  }

  if (!blocks.length) {
    return [...headerParts, "", `\`\`\`${ext}`, content, "```"].join("\n");
  }

  const fileLines = content.split("\n");
  const headerText = fileLines
    .slice(0, originalFirstBlockLine)
    .join("\n")
    .trim();
  const parts: string[] = [...headerParts];

  if (headerText) {
    parts.push(
      "",
      `#### ${file.path} — module header`,
      "",
      `\`\`\`${ext}`,
      headerText,
      "```",
    );
  }

  for (const block of blocks) {
    parts.push(
      "",
      `#### ${file.path} — ${block.name}`,
      "",
      `Function or symbol \`${block.name}\` in \`${file.path}\` (${role}, ${repoName}).`,
      "",
      `\`\`\`${ext}`,
      block.text,
      "```",
    );
  }

  return parts.join("\n");
}

// ─── Word counting ────────────────────────────────────────────────────────────

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ─── Split source blocks into batches of up to maxFilesPerBatch ──────────────
// Input must already be sorted by filePath for deterministic batching.
function splitSourceBlocksIntoBatches(
  sourceBlocks: Block[],
  maxFilesPerBatch: number,
): Block[][] {
  const batches: Block[][] = [];
  let currentBatch: Block[] = [];
  for (const block of sourceBlocks) {
    if (currentBatch.length >= maxFilesPerBatch) {
      batches.push(currentBatch);
      currentBatch = [];
    }
    currentBatch.push(block);
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches;
}

// ─── Write a single notebook folder ──────────────────────────────────────────
async function writeNotebookFolder(
  batch: Block[],
  folderIndex: number,
  outputDir: string,
): Promise<{
  name: string;
  fileCount: number;
  groups: string[];
  filePaths: string[];
  localManifestPath: string;
}> {
  const folderName = `notebook_${String(folderIndex + 1).padStart(2, "0")}`;
  const folderPath = join(outputDir, folderName);
  mkdirSync(folderPath, { recursive: true });

  const groupsSet = new Set<string>();
  const originalFilePaths: string[] = [];

  for (let i = 0; i < batch.length; i++) {
    const block = batch[i];
    groupsSet.add(block.group);
    let filePath = block.filePath;
    if (!filePath) {
      const firstLine = block.text.split("\n")[0];
      const match = firstLine.match(/^### (.+?) \(/);
      filePath = match ? match[1] : `file_${i + 1}_NB${folderIndex + 1}`;
    }
    originalFilePaths.push(filePath);

    const fileName = `file_${String(i + 1).padStart(3, "0")}_NB${folderIndex + 1}.txt`;
    const fileFullPath = join(folderPath, fileName);
    await writeFile(fileFullPath, block.text, "utf-8");
  }

  // Sort groups for deterministic manifest output
  const sortedGroups = Array.from(groupsSet).sort();

  // Write local manifest (always included)
  const manifestLines = [
    `# Manifest for ${folderName}`,
    `Generated: ${new Date().toISOString()}`,
    `Contains ${batch.length} source files.`,
    `Groups: ${sortedGroups.join(", ")}`,
    ``,
    `Files in this notebook:`,
    ...originalFilePaths.map(
      (fp, idx) =>
        `file_${String(idx + 1).padStart(3, "0")}_NB${folderIndex + 1}.txt -> ${fp}`,
    ),
    ``,
    `[RELATIONAL ANCHORS]`,
    `This notebook contains files marked as 'Stateful Callers' or 'Mappers'.`,
    `Check the 'Cross-notebook dependencies' header in each file for precise links.`,
    ``,
    `END OF MANIFEST`,
  ];
  const manifestPath = join(folderPath, "00_manifest.txt");
  await writeFile(manifestPath, manifestLines.join("\n"), "utf-8");

  return {
    name: folderName,
    fileCount: batch.length,
    groups: sortedGroups,
    filePaths: originalFilePaths,
    localManifestPath: manifestPath,
  };
}

// ─── Write root manifest and meta file ───────────────────────────────────────
async function writeRootManifest(
  metaTexts: string[],
  folderInfos: Array<{
    name: string;
    fileCount: number;
    groups: string[];
    filePaths: string[];
  }>,
  outputDir: string,
  repoContext: any,
  lang: RepoLanguage,
  totalSourceFiles: number,
  droppedTiers: number[],
  allCandidatesCount: number,
  globalDeps: Map<number, Set<number>>,
): Promise<{ rootManifestPath: string; metaFilePath: string }> {
  // Write the meta file (01_Meta.txt)
  const metaFilePath = join(outputDir, "01_Meta.txt");
  const logicalCouplesText =
    "## Functional Relationships (Logical Couples)\n" +
    "This codebase contains 'Logical Couples' where one file defines a data transformation (The Mapper) " +
    "and another file contains the stateful aggregation loop (The Aggregator). \n\n" +
    "RepoOrbit has bundled these together into 'Logic Units'. When analyzing a Mapper, the Planner " +
    "should also check its corresponding Aggregator in the manifest to understand the full stateful flow.";

  await writeFile(
    metaFilePath,
    [...metaTexts, logicalCouplesText].join("\n\n"),
    "utf-8",
  );

  // Build root manifest lines
  const lines: string[] = [
    `00_Root_Manifest.txt — ${repoContext?.meta?.fullName ?? "Unknown"} Root Manifest`,
    `Generated: ${new Date().toISOString()}`,
    `Language profile: ${lang}`,
    `Mode: ${droppedTiers.length > 0 ? "BUDGET-CONSTRAINED (dropped tiers: " + droppedTiers.join(",") + ")" : "FULL (all source files)"}`,
    `Total files considered: ${allCandidatesCount}`,
    `Total source files selected: ${totalSourceFiles}`,
    `Split into ${folderInfos.length} notebooks (max 49 files per notebook)`,
    "",
  ];

  if (globalDeps.size > 0) {
    lines.push("## Cross‑Notebook Dependencies & Relational Anchors");
    const sortedNotebooks = Array.from(globalDeps.keys()).sort((a, b) => a - b);
    for (const srcIdx of sortedNotebooks) {
      const srcName = `notebook_${String(srcIdx + 1).padStart(2, "0")}`;
      const targets = Array.from(globalDeps.get(srcIdx)!).sort((a, b) => a - b);
      const targetNames = targets
        .map((t) => `notebook_${String(t + 1).padStart(2, "0")}`)
        .join(", ");

      const relationalNote = targets.some((t) => t < srcIdx)
        ? " (Contains Callers/Aggregators)"
        : "";
      lines.push(`- ${srcName} depends on: ${targetNames}${relationalNote}`);
    }
    lines.push("");
  }

  lines.push("# Notebooks", "");
  for (const info of folderInfos) {
    lines.push(`## ${info.name}`);
    lines.push(`- Contains ${info.fileCount} source files.`);
    lines.push(`- Groups: ${info.groups.join(", ")}`);
    // Print ALL file paths — no truncation — so the orchestrator has a
    // complete picture of every notebook's contents.
    lines.push(`- Files:`);
    for (const fp of info.filePaths) {
      lines.push(`  - ${fp}`);
    }
    lines.push("");
  }
  lines.push("END OF MANIFEST");

  const rootManifestPath = join(outputDir, "00_Root_Manifest.txt");
  await writeFile(rootManifestPath, lines.join("\n"), "utf-8");

  return { rootManifestPath, metaFilePath };
}

// ─── Main export ──────────────────────────────────────────────────────────────
export async function buildMasterContext(
  query: string,
  filesMetadata: any[],
  importGraph: Record<string, string[]>,
  repoContext: any,
  expertPlan?: ExpertPlan,
  outputDir = "/tmp/notebooklm_sources",
  dumpAll = true,
): Promise<string> {
  const repoName = repoContext?.meta?.fullName?.split("/").pop() ?? "repo";
  const safeQuery = query ? String(query) : "";

  const lang = detectRepoLanguage(filesMetadata);

  const cIncludeGraph =
    lang === "c" || lang === "mixed"
      ? buildCIncludeGraph(filesMetadata)
      : ({} as Record<string, string[]>);

  const mergedImportGraph = { ...importGraph, ...cIncludeGraph };

  const intents = dumpAll
    ? ([
        "code",
        "repo_meta",
        "contributors",
        "commits",
        "branches",
        "issues",
        "pulls",
        "tree",
      ] as QueryIntent[])
    : (expertPlan?.intents ?? detectIntent(safeQuery));

  const needsCode =
    dumpAll ||
    intents.includes("code") ||
    intents.includes("test") ||
    (expertPlan?.files && expertPlan.files.length > 0);

  const focus = dumpAll
    ? "generic"
    : (expertPlan?.focus ??
      (needsCode ? detectCodeFocus(safeQuery) : "generic"));

  // ── Sort all candidates lexicographically by path before any processing ──
  // This is the root of determinism: every downstream collection derives from
  // this sorted list, so file-to-notebook assignments are stable across runs.
  const allCandidates = filesMetadata
    .filter(
      (f) => f && typeof f.path === "string" && shouldInclude(f.path, lang),
    )
    .sort((a, b) => (a.path as string).localeCompare(b.path));

  const estimateWords = (f: any) =>
    Math.ceil((f.metrics?.charCount ?? f.content?.length ?? 0) / 5);

  const { files: allIncluded, droppedTiers } = selectFilesByBudget(
    allCandidates,
    estimateWords,
    lang,
  );

  // Preserve lexicographic order after budget filtering
  const allIncludedSorted = [...allIncluded].sort((a, b) =>
    (a.path as string).localeCompare(b.path),
  );

  const docFiles = allIncludedSorted.filter((f) => isDocFile(f.path));
  const sourceFiles = allIncludedSorted.filter((f) => !isDocFile(f.path));

  // Accumulators
  const metaTexts: string[] = [];
  const sourceBlocks: Block[] = [];

  const pushMeta = (text: string) => {
    if (text.trim()) metaTexts.push(text);
  };
  const pushSource = (group: string, text: string, filePath: string) => {
    if (text.trim()) sourceBlocks.push({ group, text, filePath });
  };

  // ── Meta content assembly ──────────────────────────────────────────────────
  const metaLines: string[] = [];
  metaLines.push(
    `# ${repoContext?.meta?.fullName ?? "Unknown"} — Codebase Context`,
  );
  metaLines.push(
    `Generated: ${new Date().toISOString()}. Language profile: ${lang}. Mode: ${droppedTiers.length > 0 ? "budget-constrained" : "full"}.`,
  );

  if (dumpAll || focus === "generic" || intents.includes("repo_meta")) {
    metaLines.push(getRepoMeta(repoContext, lang));
  }
  if (dumpAll || intents.includes("repo_meta") || focus === "generic") {
    const docsSection = getReadme(docFiles, dumpAll ? 5 : 3);
    if (docsSection) metaLines.push(docsSection);
  }
  if (intents.includes("contributors")) {
    const s = getContributorsNames(repoContext);
    if (s) metaLines.push(s);
  }
  if (intents.includes("commits")) {
    const s = getCommitHistory(repoContext);
    if (s) metaLines.push(s);
  }
  if (intents.includes("branches")) {
    const s = getBranches(repoContext);
    if (s) metaLines.push(s);
  }
  if (intents.includes("issues")) {
    const s = getIssues(repoContext);
    if (s) metaLines.push(s);
  }
  if (intents.includes("pulls")) {
    const s = getPulls(repoContext);
    if (s) metaLines.push(s);
  }

  if (
    dumpAll ||
    intents.includes("tree") ||
    (intents.includes("repo_meta") && focus === "generic")
  ) {
    const extFreq = repoContext?.stats?.extFrequency ?? {};
    // Sort extension frequency entries for deterministic output
    const extSummary = Object.entries(extFreq)
      .sort((a: any, b: any) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([ext, count]) => `.${ext}: ${count} files`)
      .join(", ");

    metaLines.push(
      `## Directory Structure\n\n${sourceFiles.length} source files${droppedTiers.length > 0 ? " (filtered by budget)" : ""}. Types: ${extSummary}.\n\n` +
        getDirectoryStructure(filesMetadata, lang, dumpAll ? 10000 : 200),
    );
  }

  pushMeta(metaLines.join("\n\n"));

  // ── Source file processing ─────────────────────────────────────────────────
  let sortedFiles: any[] = [];
  const globalDeps = new Map<number, Set<number>>();

  if (needsCode) {
    const allGraphPaths = new Set([
      ...Object.keys(mergedImportGraph),
      ...Object.values(mergedImportGraph).flat(),
    ]);
    const importedByOthers = new Set(Object.values(mergedImportGraph).flat());
    const entryPoints = [...allGraphPaths]
      .filter((p) => !importedByOthers.has(p))
      .sort(); // sort for deterministic seed order
    const graphlessFiles = sourceFiles
      .map((f) => f.path)
      .filter((p) => !allGraphPaths.has(p))
      .sort(); // sort for deterministic seed order
    const depthMap = resolveImportDepths(
      [...entryPoints, ...graphlessFiles],
      mergedImportGraph,
      IMPORT_DEPTH,
    );

    if (dumpAll) {
      // Always sort lexicographically by path so notebook assignments are stable
      if (lang === "c") {
        sortedFiles = [...sourceFiles].sort((a, b) => {
          const sa = subsystemKey(a.path);
          const sb = subsystemKey(b.path);
          if (sa !== sb) return sa.localeCompare(sb);
          return (a.path as string).localeCompare(b.path);
        });
      } else {
        sortedFiles = [...sourceFiles].sort((a, b) =>
          (a.path as string).localeCompare(b.path),
        );
      }
    } else {
      const {
        files: selectedFiles,
        omittedCount,
        omittedPaths,
      } = selectFilesForQuery(
        sourceFiles,
        query,
        focus,
        mergedImportGraph,
        cIncludeGraph,
        depthMap,
        intents,
        lang,
      );

      if (expertPlan?.files) {
        for (const f of expertPlan.files) {
          const found = sourceFiles.find(
            (sf) => sf.path === f || sf.path.endsWith(f),
          );
          if (found && !selectedFiles.includes(found))
            selectedFiles.push(found);
        }
      }

      // Sort selected files lexicographically for deterministic ordering
      sortedFiles = [...selectedFiles].sort((a, b) =>
        (a.path as string).localeCompare(b.path),
      );

      if (omittedCount > 0) {
        pushMeta(
          `## File Selection\n\n${sortedFiles.length} files included, ${omittedCount} files omitted as irrelevant.\nSample omitted: ${omittedPaths.join(", ")}`,
        );
      }
    }

    // Build global index map: filePath -> global file index
    const globalFileIndexMap = new Map<string, number>();
    for (let i = 0; i < sortedFiles.length; i++) {
      globalFileIndexMap.set(sortedFiles[i].path, i);
    }

    // C include graph summary goes to meta
    if (lang === "c" || lang === "mixed") {
      const selectedPaths = new Set(sortedFiles.map((f) => f.path));
      const includeGraphSummary = getCIncludeGraphSummary(
        cIncludeGraph,
        selectedPaths,
      );
      if (includeGraphSummary) pushMeta(includeGraphSummary);
    }

    const graphHeader =
      `## ${lang === "c" ? "Include" : "Import"} Graph and File Roles\n\n` +
      `- **Entry Point**: not ${lang === "c" ? "included by" : "imported by"} any other file.\n` +
      `- **Depth N**: N hops from an entry point.\n` +
      `- **Utility**: not in the ${lang === "c" ? "include" : "import"} graph.\n\n` +
      `Entry points: ${entryPoints.slice(0, 20).join(", ") || "none detected"}.`;

    if (sortedFiles.length > 0) pushMeta(graphHeader);

    // ── Pass 1: compute cross‑notebook dependencies for every file ─────────
    const fileCrossDeps = new Map<number, string[]>();

    for (let i = 0; i < sortedFiles.length; i++) {
      const file = sortedFiles[i];
      const notebookIdx = Math.floor(i / 49);
      // Sort deps for deterministic cross-dep listing
      const deps = (mergedImportGraph[file.path] ?? []).slice().sort();
      const crossDeps: string[] = [];

      for (const depPath of deps) {
        const depGlobalIdx = globalFileIndexMap.get(depPath);
        if (depGlobalIdx !== undefined) {
          const depNotebookIdx = Math.floor(depGlobalIdx / 49);
          if (depNotebookIdx !== notebookIdx) {
            const depLocalIdx = depGlobalIdx % 49;
            const depLocalFileName = `file_${String(depLocalIdx + 1).padStart(3, "0")}_NB${depNotebookIdx + 1}.txt`;
            const depNotebookName = `notebook_${String(depNotebookIdx + 1).padStart(2, "0")}`;
            crossDeps.push(
              `${depNotebookName}: ${depLocalFileName} (${depPath})`,
            );

            if (!globalDeps.has(notebookIdx))
              globalDeps.set(notebookIdx, new Set());
            globalDeps.get(notebookIdx)!.add(depNotebookIdx);
          }
        }
      }

      if (crossDeps.length > 0) {
        fileCrossDeps.set(i, crossDeps);
      }
    }

    // ── Pass 2: generate file context blocks ────────────────────────────────
    for (let i = 0; i < sortedFiles.length; i++) {
      const file = sortedFiles[i];
      const notebookIdx = Math.floor(i / 49);
      const notebookName = `notebook_${String(notebookIdx + 1).padStart(2, "0")}`;
      const crossDeps = fileCrossDeps.get(i) ?? [];

      let fileContext = getFileContext(
        file,
        importRoleLabel(depthMap.get(file.path)),
        repoName,
        lang,
        notebookName,
        crossDeps,
      );

      if (crossDeps.length > 0) {
        fileContext += `\n\nCross‑notebook dependencies:\n- ${crossDeps.join("\n- ")}`;
      }

      const group =
        lang === "c"
          ? subsystemKey(file.path)
          : file.path.split("/")[0] || "_root";
      pushSource(group, fileContext, file.path);
    }
  }

  pushMeta(
    `## End of Context\n\nLanguage profile: ${lang}. Source files: ${needsCode ? "included" : "not included (meta-only query)"}.`,
  );

  // Add global dependency summary to metaTexts
  if (globalDeps.size > 0) {
    const depLines: string[] = ["## Cross‑Notebook Dependency Graph"];
    // Sort notebook indices for deterministic output
    const sortedNotebooks = Array.from(globalDeps.keys()).sort((a, b) => a - b);
    for (const srcIdx of sortedNotebooks) {
      const srcName = `notebook_${String(srcIdx + 1).padStart(2, "0")}`;
      // Sort dependent notebook indices for deterministic output
      const targets = Array.from(globalDeps.get(srcIdx)!).sort((a, b) => a - b);
      const targetNames = targets
        .map((t) => `notebook_${String(t + 1).padStart(2, "0")}`)
        .join(", ");
      depLines.push(`- ${srcName} depends on: ${targetNames}`);
    }
    pushMeta(depLines.join("\n"));
  }

  // sourceBlocks are already in sorted order (pushed in sortedFiles order above)
  const batches = splitSourceBlocksIntoBatches(sourceBlocks, 49);
  const folderInfos = [];
  for (let i = 0; i < batches.length; i++) {
    const info = await writeNotebookFolder(batches[i], i, outputDir);
    folderInfos.push(info);
  }

  const { rootManifestPath } = await writeRootManifest(
    metaTexts,
    folderInfos,
    outputDir,
    repoContext,
    lang,
    sourceBlocks.length,
    droppedTiers,
    allCandidates.length,
    globalDeps,
  );

  const rootManifestContent = await readFile(rootManifestPath, "utf-8");
  return rootManifestContent;
}
