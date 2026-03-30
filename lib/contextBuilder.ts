import { mkdirSync, createWriteStream } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";

const IMPORT_DEPTH = 99999;
const SPLIT_THRESHOLD_CHARS = 3_000;

const STREAM_PART_BYTES = 100_000_000; // Let NotebookLM handle larger chunks instead of us splitting them.
const MAX_SOURCE_BUCKETS = 49;

type RepoLanguage =
  | "c"
  | "web"
  | "go"
  | "rust"
  | "python"
  | "java"
  | "kotlin"
  | "swift"
  | "ruby"
  | "php"
  | "scala"
  | "elixir"
  | "mixed";

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

const EXCLUDE_PATTERNS: RegExp[] = [
  /\.(png|jpe?g|gif|svg|ico|webp|avif|tiff|bmp|woff2?|ttf|eot|otf)$/i,
  /node_modules/,
  /^\.git\//,
  /^\.next\//,
  /^\.nuxt\//,
  /^\.venv\//,
  /\.DS_Store$/,
  /\.playwright-auth\.json$/,
  /auth\.json$/,
  /\.eslintcache$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /composer\.lock$/,
  /Cargo\.lock$/,
  /poetry\.lock$/,
  /Gemfile\.lock$/,
  /\.gitignore$/,
  /\.gitattributes$/,
  /\.gitmodules$/,
];

// ─── Types ────────────────────────────────────────────────────────────────────

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

interface Block {
  group: string;
  text: string;
}

export interface ExpertPlan {
  files?: string[];
  intents?: QueryIntent[];
  focus?: CodeFocus;
}

// ─── Subsystem map (Linux kernel) ─────────────────────────────────────────────
// Maps top-level directory prefix → human-readable subsystem name.
// Used to group files into subsystem-coherent buckets instead of word-count splits.

// ─── Heuristic Importance Ranking (repo-agnostic) ─────────────────────────────
// Replaces hardcoded Linux subsystem maps. Works for any codebase language.

export function rankFileImportance(
  filePath: string,
  exports: string[],
  refsCount: number,
): number {
  let rank = 0;
  const parts = filePath.split("/");
  if (parts.length === 1) rank += 60;
  else if (parts.length === 2) rank += 30;
  if (parts[0] === "include" || parts[0] === "src") rank += 20;
  const name = parts[parts.length - 1].toLowerCase().replace(/\..*$/, "");
  if (
    /^(main|index|app|init|entry|server|mod|lib|readme|readme_.*)$/.test(name)
  )
    rank += 100;
  if (isDocFile(filePath)) rank += 50;
  rank += Math.min((exports?.length || 0) * 3, 60);
  rank += Math.min((refsCount || 0) * 2, 40);
  return rank;
}

function subsystemKey(filePath: string): string {
  return filePath.split("/")[0] || "_root";
}

// ─── Intent / focus detection ─────────────────────────────────────────────────

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

// ─── Token extraction ─────────────────────────────────────────────────────────

// ─── C-aware symbol extraction ────────────────────────────────────────────────
// Extracts function names, macro names, struct/typedef names from C source.
// Used to enrich scoring when importGraph is empty (all C repos).

function extractCSymbols(content: string): string[] {
  const syms = new Set<string>();

  // Function definitions: return_type function_name(
  for (const m of content.matchAll(/^[\w\s\*]+?\b(\w+)\s*\(/gm)) {
    const name = m[1];
    if (
      name &&
      name.length > 2 &&
      !["if", "for", "while", "switch", "return"].includes(name)
    )
      syms.add(name);
  }

  // #define MACRO_NAME
  for (const m of content.matchAll(/^#\s*define\s+(\w+)/gm))
    if (m[1]) syms.add(m[1]);

  // struct/union/typedef names
  for (const m of content.matchAll(/(?:struct|union|typedef)\s+(\w+)/g))
    if (m[1]) syms.add(m[1]);

  // EXPORT_SYMBOL / EXPORT_SYMBOL_GPL — these are the kernel's "exports"
  for (const m of content.matchAll(/EXPORT_SYMBOL(?:_GPL)?\s*\(\s*(\w+)\s*\)/g))
    if (m[1]) syms.add(m[1]);

  return [...syms];
}

// ─── C call-graph extraction ──────────────────────────────────────────────────
// Builds a lightweight include-graph for C files since importGraph is JS-only.
// Returns a map: filePath → list of #included local paths (best-effort).

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

// ─── File selection ───────────────────────────────────────────────────────────

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

function fileTier(filePath: string, _lang: RepoLanguage = "web"): number {
  if (EXCLUDE_PATTERNS.some((re) => re.test(filePath))) return 0;
  return 1;
}

function shouldInclude(filePath: string, lang: RepoLanguage = "web"): boolean {
  return fileTier(filePath, lang) > 0;
}

// ─── Budget-aware file selection ──────────────────────────────────────────────

// ─── Doc detection ────────────────────────────────────────────────────────────

function isDocFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  // Support .rst for kernel Documentation/
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

// ─── Binary/Poison Shield ──────────────────────────────────────────────────────
// Strips null bytes and non-printable chars that crash NotebookLM uploads.
// Preserves valid UTF-8 including scientific and international text.
function safeContent(file: any): string {
  const c = file.content;
  if (c === null || c === undefined) return "";
  let str = Buffer.isBuffer(c) ? c.toString("utf-8") : String(c);
  str = str.replace(/[\x00\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return str;
}

/**
 * Strips AI-redundant content (comments, blank lines) to fit more code into context. 
 * Preserves logic and structure.
 */
function shrinkCodeForAI(content: string, ext: string): string {
  if (!content) return "";
  const isDoc = ["md", "mdx", "rst", "txt"].includes(ext);
  if (isDoc) return content.trim();

  let lines = content.replace(/\r\n/g, "\n").split("\n");
  const isJS = ["js", "jsx", "ts", "tsx", "c", "cpp", "h", "hpp", "java", "kt", "scala", "swift", "php", "go"].includes(ext);
  const isPython = ["py", "rb", "pl", "sh", "yml", "yaml", "toml"].includes(ext);

  const result: string[] = [];
  for (let line of lines) {
    const t = line.trim();
    if (!t) {
      if (result.length > 0 && result[result.length - 1] !== "") result.push("");
      continue;
    }
    // Skip full-line comments
    if (isJS && (t.startsWith("//") || (t.startsWith("/*") && t.endsWith("*/")))) continue;
    if (isPython && t.startsWith("#")) continue;
    
    // Remove trailing comments if they have space before them
    let cleanLine = line;
    if (isJS && cleanLine.includes(" //")) cleanLine = cleanLine.split(" //")[0];
    if (isPython && cleanLine.includes(" #")) cleanLine = cleanLine.split(" #")[0];

    result.push(cleanLine.trimEnd());
  }
  return result.join("\n").trim();
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

function getReadme(docFiles: any[], maxFiles = 5, charLimit = 100_000): string {
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
    if (content.length > charLimit) {
      const cut = content.lastIndexOf("\n", charLimit);
      content = content.slice(0, cut > 0 ? cut : charLimit);
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
  for (const [author, commits] of Object.entries(commitsByAuthor).sort(
    (a, b) => b[1].length - a[1].length,
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
// Emits a human-readable cross-reference block for NotebookLLM.
// Equivalent to what cscope/ctags would give for the selected files.

function getCIncludeGraphSummary(
  cIncludeGraph: Record<string, string[]>,
  selectedFilePaths: Set<string>,
): string {
  const entries = Object.entries(cIncludeGraph)
    .filter(([from]) => selectedFilePaths.has(from))
    .map(([from, deps]) => {
      const relevantDeps = deps.filter((d) => selectedFilePaths.has(d));
      return relevantDeps.length
        ? `- ${from} includes: ${relevantDeps.join(", ")}`
        : null;
    })
    .filter(Boolean);

  if (!entries.length) return "";
  return `## C Include Graph (selected files)\n\nLocal #include relationships among included files:\n\n${entries.join("\n")}`;
}

// ─── Function block parsing ───────────────────────────────────────────────────
// JS/TS parser (unchanged from original)

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
// Splits a C file into per-function blocks for structured context.

function parseCFunctionBlocks(content: string): FunctionBlock[] {
  const lines = content.split("\n");
  const blocks: FunctionBlock[] = [];

  // Match C function definitions: lines that look like `type name(` not inside a struct/enum
  // Heuristic: function def = a non-indented line ending in `)` or starting a `{` on next line.
  const defRe = /^[a-zA-Z_][\w\s\*]*\b(\w+)\s*\([^;]*$/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Skip preprocessor, comments, empty
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

    const m = defRe.exec(lines[i]); // test original (unstripped) for indentation guard
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

    // Scan for opening brace
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

    // Count braces to find closing
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
      // Only keep blocks of reasonable size (skip 1-line stubs, extremely huge functions)
      const lineCount = j - i + 1;
      if (lineCount >= 3 && lineCount <= 500) {
        blocks.push({ name, startLine: i, endLine: j, text });
      }
    }

    i = found ? j + 1 : i + 1;
  }
  return blocks;
}

// ─── File context generation ──────────────────────────────────────────────────

function getFileContext(
  file: any,
  role: ImportRole,
  repoName: string,
  _lang: RepoLanguage,
  charLimit = 100_000,
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
  if (isCFile) {
    const symbols = extractCSymbols(safeContent(file));
    exportsStr = symbols.length
      ? `Symbols (functions, macros, structs, EXPORT_SYMBOL): ${symbols.slice(0, 30).join(", ")}${symbols.length > 30 ? ` and ${symbols.length - 30} more` : ""}.`
      : "No detected public symbols.";
  } else {
    exportsStr = exports.length
      ? `It exports: ${exports.join(", ")}.`
      : "It has no named exports.";
  }

  const importsStr = imports.length
    ? `It imports from: ${imports.slice(0, 12).join(", ")}${imports.length > 12 ? ` and ${imports.length - 12} more` : ""}.`
    : isCFile
      ? "" // C imports shown in include graph section
      : "It has no imports.";

  const todosStr = todos.length ? ` TODOs: ${todos.join(" | ")}.` : "";
  const flagsStr = flags ? ` (${flags})` : "";

  const prose =
    `This file is a **${role}** in the ${repoName} ${isCFile ? "include" : "import"} graph${flagsStr}. ` +
    `Logic type: ${logicType}. ${lineCount} lines (${codeLines} code lines). ` +
    `${exportsStr}${importsStr ? " " + importsStr : ""}${todosStr}`;

  let content = shrinkCodeForAI(safeContent(file), ext);

  if (content.length > charLimit) {
    const cut = content.lastIndexOf("\n", charLimit);
    content = content.slice(0, cut > 0 ? cut : charLimit);
  }

  const heading = `### ${file.path} (${role})`;
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

  if (content.length <= SPLIT_THRESHOLD_CHARS || isNonCodeFile) {
    return [heading, "", prose, "", `\`\`\`${ext}`, content, "```"].join("\n");
  }

  // Choose parser based on language
  const blocks = isCFile
    ? parseCFunctionBlocks(content)
    : parseFunctionBlocks(content);

  if (!blocks.length) {
    return [heading, "", prose, "", `\`\`\`${ext}`, content, "```"].join("\n");
  }

  const fileLines = content.split("\n");
  const headerText = fileLines.slice(0, blocks[0].startLine).join("\n").trim();
  const parts: string[] = [heading, "", prose];

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

// ─── Directory-Aware Stream Packer ────────────────────────────────────────────
// Groups blocks by top-level directory so neighboring files stay together.
// Streams directly to disk: never holds full content in RAM (OOM-safe).

async function streamPack(
  blocks: Block[],
  outDir: string,
  _lang: RepoLanguage,
): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });

  // Dynamically calculate part size to hit MAX_SOURCE_BUCKETS (49)
  const totalBytes = blocks.reduce(
    (acc, b) => acc + Buffer.byteLength(b.text, "utf-8") + 4,
    0,
  );
  // Target roughly MAX_SOURCE_BUCKETS files.
  // Use a minimum target size of 1 byte to ensure we split as much as possible if user insists on 50.
  const targetPartSize = Math.max(
    1,
    Math.ceil(totalBytes / MAX_SOURCE_BUCKETS),
  );

  type WriteStream = ReturnType<typeof createWriteStream>;
  const writtenPaths: string[] = [];
  let fileIdx = 0;
  let currentBytes = 0;
  let currentStream: WriteStream | undefined;

  const openPart = (): boolean => {
    currentStream?.end();
    if (fileIdx >= MAX_SOURCE_BUCKETS) {
      currentStream = undefined;
      return false;
    }
    const fullPath = join(
      outDir,
      `part_${String(fileIdx + 1).padStart(2, "0")}.txt`,
    );
    writtenPaths.push(fullPath);
    currentStream = createWriteStream(fullPath, { encoding: "utf-8" });
    currentBytes = 0;
    fileIdx++;
    return true;
  };

  if (!openPart()) return writtenPaths;

  for (const block of blocks) {
    if (fileIdx > MAX_SOURCE_BUCKETS && currentBytes > 0) break;
    const chunkBytes = Buffer.byteLength(block.text, "utf-8") + 4;

    // If the next block would exceed the dynamic target size, start a new part.
    // However, also respect the absolute 10MB limit if the dynamic size was larger.
    const limit = Math.min(STREAM_PART_BYTES, targetPartSize);

    if (currentBytes > 0 && currentBytes + chunkBytes > limit) {
      if (!openPart()) break;
    }
    currentStream?.write(block.text + "\n\n");
    currentBytes += chunkBytes;
  }

  currentStream?.end();
  return writtenPaths;
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

function buildManifest(
  fileCount: number,
  repoName: string,
  repoContext: any,
  droppedTiers: number[],
  totalSourceFiles: number,
  lang: RepoLanguage,
): string {
  const timestamp = new Date().toISOString();
  const langNote =
    lang === "c"
      ? [
          "",
          "C/SYSTEMS REPO NOTES:",
          "  - Files sorted and packed by kernel subsystem (arch/, block/, fs/, mm/, net/, etc.)",
          "  - Kconfig, assembly (.S), and linker script (.ld) files included as Tier 1/2",
          "  - C symbols extracted from EXPORT_SYMBOL, struct, typedef, and function definitions",
          "  - C include graph (#include directives) replaces JS import graph for cross-reference",
          "  - parseCFunctionBlocks() used instead of JS-only parseFunctionBlocks()",
        ].join("\n")
      : "";

  return [
    `00_Repo_Manifest.txt — ${repoName}`,
    `Generated: ${timestamp}`,
    `Repository: ${repoContext?.meta?.fullName ?? repoName}`,
    `Description: ${repoContext?.github?.description ?? "N/A"}`,
    `Detected language profile: ${lang}`,
    "",
    `Mode: ${droppedTiers.length > 0 ? "BUDGET-CONSTRAINED (dropped tiers: " + droppedTiers.join(",") + ")" : "FULL (all source files)"}`,
    `Total files considered: ${totalSourceFiles}`,
    `Output files produced: ${fileCount} source buckets + this manifest = ${fileCount + 1} total`,
    langNote,
    "",
    `Each part_NN.txt contains source code${lang === "c" ? " grouped by kernel subsystem" : " organized alphabetically by directory"}.`,
    `Upload all files (including this manifest) to NotebookLM as sources.`,
    "",
    "END OF MANIFEST",
  ].join("\n");
}

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

  const allCandidates = filesMetadata.filter(
    (f) => f && typeof f.path === "string" && shouldInclude(f.path, lang),
  );

  // DYNAMIC COMPRESSION: ensure massive repos fit in 50 parts by truncating each file.
  const TOTAL_CAPACITY = MAX_SOURCE_BUCKETS * STREAM_PART_BYTES; // e.g. 49 * 25MB = 1.225 GB
  const rawTotalBytes = allCandidates.reduce(
    (s, f) => s + (f.metrics?.charCount ?? f.content?.length ?? 0),
    0,
  );

  let dynamicCharLimit = 100_000_000; // Default 100MB
  if (rawTotalBytes > TOTAL_CAPACITY) {
    // If repo is > capacity, calculate a sustainable limit per file to ensure breadth.
    const avgPerFile = Math.floor(TOTAL_CAPACITY / allCandidates.length);
    // Allow at least 2KB even for huge repos, but try to fit everything.
    dynamicCharLimit = Math.max(2000, avgPerFile);
  }

  const allIncluded = allCandidates;
  const droppedTiers: number[] = [];

  const docFiles = allIncluded.filter((f) => isDocFile(f.path));
  // Include everything as source files so README, etc. are processed as full context docs.
  const sourceFiles = allIncluded;

  const blocks: Block[] = [];
  const push = (group: string, text: string) => {
    if (text.trim()) blocks.push({ group, text });
  };

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
    const docsSection = getReadme(
      docFiles,
      dumpAll ? 1000 : 3,
      dynamicCharLimit,
    );
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
    const extSummary = Object.entries(extFreq)
      .sort((a: any, b: any) => b[1] - a[1])
      .slice(0, 10)
      .map(([ext, count]) => `.${ext}: ${count} files`)
      .join(", ");

    metaLines.push(
      `## Directory Structure\n\n${sourceFiles.length} source files${droppedTiers.length > 0 ? " (filtered by budget)" : ""}. Types: ${extSummary}.\n\n` +
        getDirectoryStructure(filesMetadata, lang, dumpAll ? 10000 : 200),
    );
  }

  push("_meta", metaLines.join("\n\n"));

  if (needsCode) {
    const allGraphPaths = new Set([
      ...Object.keys(mergedImportGraph),
      ...Object.values(mergedImportGraph).flat(),
    ]);
    const importedByOthers = new Set(Object.values(mergedImportGraph).flat());
    const entryPoints = [...allGraphPaths].filter(
      (p) => !importedByOthers.has(p),
    );
    const graphlessFiles = sourceFiles
      .map((f) => f.path)
      .filter((p) => !allGraphPaths.has(p));
    const depthMap = resolveImportDepths(
      [...entryPoints, ...graphlessFiles],
      mergedImportGraph,
      IMPORT_DEPTH,
    );

    // Sort all files by heuristic importance
    const sortedFiles = [...sourceFiles].sort((a, b) => {
      const scoreA = rankFileImportance(
        a.path,
        a.analysis?.exports ?? [],
        a.refsCount ?? 0,
      );
      const scoreB = rankFileImportance(
        b.path,
        b.analysis?.exports ?? [],
        b.refsCount ?? 0,
      );
      if (scoreA !== scoreB) return scoreB - scoreA;
      return a.path.localeCompare(b.path);
    });

    // C include graph summary — acts as a lightweight cscope substitute
    if (lang === "c" || lang === "mixed") {
      const selectedPaths = new Set(sortedFiles.map((f) => f.path));
      const includeGraphSummary = getCIncludeGraphSummary(
        cIncludeGraph,
        selectedPaths,
      );
      if (includeGraphSummary) push("_meta", includeGraphSummary);
    }

    const graphHeader =
      `## ${lang === "c" ? "Include" : "Import"} Graph and File Roles\n\n` +
      `- **Entry Point**: not ${lang === "c" ? "included by" : "imported by"} any other file.\n` +
      `- **Depth N**: N hops from an entry point.\n` +
      `- **Utility**: not in the ${lang === "c" ? "include" : "import"} graph.\n\n` +
      `Entry points: ${entryPoints.slice(0, 20).join(", ") || "none detected"}.`;

    if (sortedFiles.length > 0) push("_meta", graphHeader);

    for (const file of sortedFiles) {
      const fileContext = getFileContext(
        file,
        importRoleLabel(depthMap.get(file.path)),
        repoName,
        lang,
        dynamicCharLimit,
      );
      const group =
        lang === "c"
          ? subsystemKey(file.path)
          : file.path.split("/")[0] || "_root";
      push(group, fileContext);
    }
  }

  push(
    "_meta",
    `## End of Context\n\nLanguage profile: ${lang}. Source files: ${needsCode ? "included" : "not included (meta-only query)"}.`,
  );

  const writtenPaths = await streamPack(blocks, outputDir, lang);

  const manifestText = buildManifest(
    writtenPaths.length,
    repoName,
    repoContext,
    droppedTiers,
    allCandidates.length,
    lang,
  );
  const manifestPath = join(outputDir, "00_Repo_Manifest.txt");
  await writeFile(manifestPath, manifestText, "utf-8");

  return manifestText;
}
