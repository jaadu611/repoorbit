import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
const traverse = (_traverse as any).default || _traverse;

// ─── Constants ────────────────────────────────────────────────────────────────

// Maximum number of scored candidate files to consider (was 15 — too many)
const MAX_CANDIDATES = 5;

// Snip window around a match in lines (was ±100 — too wide)
const SNIP_WINDOW = 30;

// Hard cap on total bundle size in characters (~50KB).
// Prevents a single gap fill from producing a 116K file.
const MAX_BUNDLE_CHARS = 50_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase().replace(/\\/g, "/");
  return (
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.includes("/spec/") ||
    lower.includes("/__tests__/") ||
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.endsWith(".test.ts") ||
    lower.endsWith(".test.js") ||
    lower.endsWith(".spec.ts") ||
    lower.endsWith(".spec.js")
  );
}

function resolveFilePath(outDir: string, loosePath: string): string | null {
  if (!loosePath) return null;
  const candidates = [
    path.join(outDir, "source_mirror", loosePath),
    path.join(outDir, loosePath),
    loosePath,
  ];

  // Fuzzy mapping for common build patterns (e.g. lib/foo.js -> _src/lib/foo.coffee)
  const base = loosePath.replace(/\.[a-z0-9]+$/, "");
  const extensions = [".ts", ".js", ".coffee", ".py", ".go", ".rs"];
  const prefixes = ["", "src/", "_src/", "lib/"];
  
  for (const p of prefixes) {
    for (const ext of extensions) {
      const cleanBase = base.replace(/^(src|lib|_src)\//, "");
      candidates.push(path.join(outDir, "source_mirror", p, base + ext));
      candidates.push(path.join(outDir, "source_mirror", p, cleanBase + ext));
    }
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function contentMentionsSymbol(content: string, symbol: string): boolean {
  const root = symbol.split(".")[0].split("(")[0].trim();
  const escapedFull = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`\\b${escapedFull}\\b`).test(content) ||
    new RegExp(`\\b${escapedRoot}\\b`).test(content)
  );
}

/**
 * Extract the target function from source code using AST.
 * Exact match first, substring fallback, whole-file last resort.
 */
function extractTargetFunction(code: string, hint: string): string {
  const lowerHint = hint.toLowerCase();
  const isExact = (name: string) => name.toLowerCase() === lowerHint;
  const isSubstring = (name: string) => {
    const n = name.toLowerCase();
    return n.includes(lowerHint) || lowerHint.includes(n);
  };

  try {
    const ast = parse(code, {
      sourceType: "module",
      plugins: [
        "typescript",
        "jsx",
        ["decorators", { decoratorsBeforeExport: true }],
      ],
    });

    const exactBlocks: string[] = [];
    const substringBlocks: string[] = [];

    traverse(ast, {
      FunctionDeclaration(p: any) {
        const name = p.node.id?.name;
        if (!name) return;
        const block = code.slice(p.node.start!, p.node.end!);
        if (isExact(name)) exactBlocks.push(block);
        else if (isSubstring(name)) substringBlocks.push(block);
      },
      VariableDeclarator(p: any) {
        if (!p.node.init || (p.node.init.type !== "FunctionExpression" && p.node.init.type !== "ArrowFunctionExpression")) return;
        const id = p.node.id;
        if (id.type !== "Identifier") return;
        const name = id.name;
        const decl = p.parentPath.node;
        if (decl.type !== "VariableDeclaration") return;
        const block = code.slice(decl.start!, decl.end!);
        if (isExact(name)) exactBlocks.push(block);
        else if (isSubstring(name)) substringBlocks.push(block);
      },
      AssignmentExpression(p: any) {
        if (p.node.right.type !== "FunctionExpression" && p.node.right.type !== "ArrowFunctionExpression") return;
        const left = p.node.left;
        let name = "";
        if (left.type === "MemberExpression" && left.property.type === "Identifier") name = left.property.name;
        else if (left.type === "Identifier") name = left.name;
        if (!name) return;
        const block = code.slice(p.node.start!, p.node.end!);
        if (isExact(name)) exactBlocks.push(block);
        else if (isSubstring(name)) substringBlocks.push(block);
      },
      ClassMethod(p: any) {
        const id = p.node.key;
        if (id.type !== "Identifier") return;
        const name = id.name;
        const block = code.slice(p.node.start!, p.node.end!);
        if (isExact(name)) exactBlocks.push(block);
        else if (isSubstring(name)) substringBlocks.push(block);
      },
    });

    if (exactBlocks.length > 0) return exactBlocks.join("\n\n");
    if (substringBlocks.length > 0) return substringBlocks.join("\n\n");
  } catch {
    // AST failed — try regex fallback for Go/C/C++
    const cDefPatterns = [
      new RegExp(`^[^\\/*\\n]*\\b${hint}\\b\\s*\\([^;]*$`, "m"), // Function definition start
      new RegExp(`^\\s*\\b${hint}\\b\\s*[:=].*->`, "m"),        // CoffeeScript
      new RegExp(`^#\\s*define\\s+${hint}\\b`, "m"),              // Macro
      new RegExp(`^(struct|union|enum|type)\\s+${hint}\\b`, "m"), // Added 'type' for Go
      new RegExp(`^typedef\\s+.*\\b${hint}\\s*;`, "m"),
    ];

    let match: RegExpExecArray | null = null;
    for (const pattern of cDefPatterns) {
      match = pattern.exec(code);
      if (match) break;
    }

    if (match) {
      const idx = match.index;
      let braceSearchIdx = idx;
      while (
        braceSearchIdx < code.length &&
        code[braceSearchIdx] !== "{" &&
        code[braceSearchIdx] !== ";"
      ) {
        braceSearchIdx++;
      }

      if (code[braceSearchIdx] === "{") {
        let depth = 0;
        let finalIdx = -1;
        for (let k = braceSearchIdx; k < code.length; k++) {
          if (code[k] === "{") depth++;
          else if (code[k] === "}") {
            depth--;
            if (depth === 0) {
              finalIdx = k;
              break;
            }
          }
        }
        if (finalIdx !== -1) return code.slice(idx, finalIdx + 1);
      } else {
        const endOfLine = code.indexOf("\n", idx);
        return code.slice(idx, endOfLine !== -1 ? endOfLine : code.length);
      }
    }

    // Snippet fallback (±30 lines) if logic can't be bounded
    const lines = code.split("\n");
    const hitIdx = lines.findIndex(l => l.toLowerCase().includes(lowerHint));
    if (hitIdx !== -1) {
      const start = Math.max(0, hitIdx - 30);
      const end = Math.min(lines.length - 1, hitIdx + 30);
      return `// [SNIPPET FALLBACK] "${hint}" found near line ${hitIdx + 1}\n` + lines.slice(start, end + 1).join("\n");
    }
  }

  return code;
}


// ─── Main export ──────────────────────────────────────────────────────────────

export function generateGapFillerNotebook(
  outDir: string,
  targetSymbol: string,
  targetFile?: string,
  searchKeywords: string[] = [],
  lastKnownNode?: string,
  contextFiles: string[] = [],
): { gapSourceFiles: string[]; gapAnalysisBundle: string } {
  const allCandidateFiles = new Set<string>();
  const scores = new Map<string, number>();

  const cleanSymbol = targetSymbol.split(" ")[0].replace(/[()]/g, "");
  const symRoot = cleanSymbol.split(".")[0];
  const escapedSymbol = cleanSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedRoot = symRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const graphPath = path.join(outDir, "graph.json");
  const symbolsPath = path.join(outDir, "symbols.json");

  let importGraph: Record<
    string,
    { imports: string[]; imported_by: string[] }
  > = {};
  let symbolIndex: Record<
    string,
    { defined_in: string; used_by_files: string }
  > = {};

  try {
    if (fs.existsSync(graphPath))
      importGraph = JSON.parse(fs.readFileSync(graphPath, "utf-8"));
    if (fs.existsSync(symbolsPath))
      symbolIndex = JSON.parse(fs.readFileSync(symbolsPath, "utf-8"));
  } catch (_) {}

  // ─── STAGE 1: Direct path resolution ──────────────────────────────────────
  // Check targetFile and lastKnownNode first — these are the highest confidence
  // sources. If found and they contain the symbol, we may not need to search further.

  const directCandidates: string[] = [
    ...(targetFile ? [targetFile] : []),
    ...(lastKnownNode ? [lastKnownNode] : []),
    ...contextFiles,
  ];

  const immediateHits: string[] = [];

  for (const loose of directCandidates) {
    const abs = resolveFilePath(outDir, loose);
    if (!abs) continue;

    const content = (() => {
      try {
        return fs.readFileSync(abs, "utf-8");
      } catch {
        return "";
      }
    })();

    if (contentMentionsSymbol(content, cleanSymbol)) {
      immediateHits.push(abs);
      const rel = path.relative(outDir, abs);
      allCandidateFiles.add(rel);
      scores.set(rel, 999999);
    }
  }

  const conductGlobalSearch = (pattern: string, weight: number) => {
    try {
      const mirrorDir = path.join(outDir, "source_mirror");
      const searchDir = fs.existsSync(mirrorDir) ? "source_mirror" : ".";
      const matches = execSync(
        `rg -l "${pattern}" ${searchDir} -g "*.{js,ts,jsx,tsx,rs,py,go,c,cpp,h,hpp,java,php,coffee}"`,
        { cwd: outDir, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
      )
        .split("\n")
        .filter(Boolean);

      matches.forEach((f) => {
        const normalized = f.startsWith("source_mirror/") ? f.slice(14) : f;
        const effectiveWeight = isTestFile(normalized)
          ? Math.round(weight * 0.2)
          : weight;
        allCandidateFiles.add(normalized);
        scores.set(normalized, (scores.get(normalized) || 0) + effectiveWeight);
      });
    } catch (_) {}
  };

  // ─── STAGE 2: Structural resolution ───────────────────────────────────────
  // If we already have an immediate hit, skip global search entirely —
  // we already know where the symbol lives.

  const structuralTargets = new Set<string>();
  if (targetFile) structuralTargets.add(targetFile);
  if (lastKnownNode) structuralTargets.add(lastKnownNode);

  if (immediateHits.length === 0) {
    // Symbol index lookup
    if (symbolIndex[cleanSymbol]) {
      const definingFile = symbolIndex[cleanSymbol].defined_in;
      structuralTargets.add(definingFile);
      conductGlobalSearch(path.basename(definingFile), 1200);
    } else if (cleanSymbol.includes(".")) {
      const subSymbol = cleanSymbol.split(".").pop() || "";
      if (symbolIndex[subSymbol]) {
        const definingFile = symbolIndex[subSymbol].defined_in;
        structuralTargets.add(definingFile);
        conductGlobalSearch(path.basename(definingFile), 1200);
      }
    }

    // Import graph neighbours
    if (Object.keys(importGraph).length > 0) {
      for (const file of structuralTargets) {
        if (importGraph[file]) {
          importGraph[file].imports.forEach((dep) =>
            conductGlobalSearch(path.basename(dep), 800),
          );
          importGraph[file].imported_by.forEach((consumer) =>
            conductGlobalSearch(path.basename(consumer), 800),
          );
        }
      }
    }

    // Heuristic keyword search
    conductGlobalSearch(`\\b${escapedSymbol}\\b`, 1000);
    if (escapedRoot !== escapedSymbol) {
      conductGlobalSearch(`\\b${escapedRoot}\\b`, 500);
    }
    searchKeywords.forEach((kw) => {
      const escapedKw = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      conductGlobalSearch(escapedKw, 300);
    });
    if (targetFile) {
      conductGlobalSearch(
        targetFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        200,
      );
    }

    // ─── STAGE 4: Token-level fallback ──────────────────────────────────────
    if (allCandidateFiles.size === 0) {
      const subTokens = cleanSymbol
        .split(/[_.\/]/)
        .flatMap((s) => s.split(/(?=[A-Z])/))
        .map((t) => t.toLowerCase())
        .filter((t) => t.length >= 4);

      for (const token of [...new Set(subTokens)]) {
        conductGlobalSearch(
          `\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          120,
        );
      }

      if (allCandidateFiles.size === 0) {
        for (const kw of searchKeywords) {
          const kwTokens = kw
            .split(/[\s_.\/]/)
            .map((t) => t.toLowerCase())
            .filter((t) => t.length >= 4);
          for (const token of [...new Set(kwTokens)]) {
            conductGlobalSearch(
              `\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
              60,
            );
          }
        }
      }
    }
  }

  if (allCandidateFiles.size === 0) {
    return { gapSourceFiles: [], gapAnalysisBundle: "" };
  }

  // ─── STAGE 5: Rank and slice ───────────────────────────────────────────────
  // Reduced from 15 to MAX_CANDIDATES — we want precision not coverage.

  const sortedFiles = Array.from(allCandidateFiles)
    .sort((a, b) => (scores.get(b) || 0) - (scores.get(a) || 0))
    .slice(0, MAX_CANDIDATES);

  // ─── STAGE 6: Build output bundle ─────────────────────────────────────────

  let gapAnalysisBundle = `// Gap-filled: ${cleanSymbol} from ${targetFile ?? "unknown"}\n\n`;
  gapAnalysisBundle += `# GAP-FILLER HARVEST\n`;
  gapAnalysisBundle += `Target Symbol: ${targetSymbol}\nTarget File: ${targetFile ?? "unknown"}\n`;
  if (lastKnownNode) {
    gapAnalysisBundle += `Last Known Node: ${lastKnownNode}\n`;
  }
  gapAnalysisBundle += `\n`;

  // Structural roadmap — keep it brief
  if (structuralTargets.size > 0) {
    gapAnalysisBundle += `## STRUCTURAL ROADMAP\n\n`;
    for (const file of structuralTargets) {
      gapAnalysisBundle += `### Anchor: ${file}\n`;
      const info = importGraph[file];
      if (info) {
        if (info.imports.length > 0)
          gapAnalysisBundle += `- Imports: ${info.imports.join(", ")}\n`;
        if (info.imported_by.length > 0)
          gapAnalysisBundle += `- Imported by: ${info.imported_by.join(", ")}\n`;
      }
      gapAnalysisBundle += `\n`;
    }
    gapAnalysisBundle += `---\n\n`;
  }

  // FIX: Direct hits — extract just the target function, not the whole file.
  // Old code dumped entire files unconditionally here, causing 116K bundles.
  const gapSourceFiles: string[] = [...immediateHits];

  if (immediateHits.length > 0) {
    gapAnalysisBundle += `## DIRECT PATH RESOLUTION (highest confidence)\n\n`;
    for (const abs of immediateHits) {
      const rel = path.relative(outDir, abs);
      const code = fs.readFileSync(abs, "utf-8");

      // Extract just the target function — if extraction fails we fall back
      // to the whole file but log a warning.
      const extracted = extractTargetFunction(code, cleanSymbol);
      const isWholeFile = extracted === code;

      if (isWholeFile) {
        console.warn(
          `[gapScout] Could not extract "${cleanSymbol}" from ${rel} — ` +
            `emitting whole file. This may indicate name_hint is a filename not a function name.`,
        );
      }

      gapAnalysisBundle += `### Source: ${rel}${isWholeFile ? " (whole-file fallback)" : ""}\n\n`;
      gapAnalysisBundle += "```typescript\n";
      gapAnalysisBundle += extracted;
      gapAnalysisBundle += "\n```\n\n---\n\n";

      // Enforce size cap after direct hits
      if (gapAnalysisBundle.length >= MAX_BUNDLE_CHARS) {
        gapAnalysisBundle += `\n// [SIZE CAP REACHED — ${MAX_BUNDLE_CHARS} chars. Remaining candidates omitted.]\n`;
        return { gapSourceFiles, gapAnalysisBundle };
      }
    }
  }

  // Scored candidates — skip if we already have direct hits from the exact file
  const emittedAbs = new Set(immediateHits.map((f) => path.resolve(f)));

  for (const f of sortedFiles) {
    if (gapAnalysisBundle.length >= MAX_BUNDLE_CHARS) {
      gapAnalysisBundle += `\n// [SIZE CAP REACHED — remaining candidates omitted]\n`;
      break;
    }

    const mirrorPath = path.join(outDir, "source_mirror", f);
    const notebookPath = path.join(outDir, f);
    const absPath = fs.existsSync(mirrorPath) ? mirrorPath : notebookPath;

    if (!fs.existsSync(absPath)) continue;
    if (emittedAbs.has(path.resolve(absPath))) continue;

    gapSourceFiles.push(absPath);
    const content = fs.readFileSync(absPath, "utf-8");
    const score = scores.get(f) || 0;
    const isHighRelevance = score >= 1000 || structuralTargets.has(f);

    if (isHighRelevance) {
      // High relevance — still extract the function, not the whole file
      const extracted = extractTargetFunction(content, cleanSymbol);
      gapAnalysisBundle += `## SOURCE: ${f}\n\n`;
      gapAnalysisBundle += "```typescript\n";
      gapAnalysisBundle += extracted;
      gapAnalysisBundle += "\n```\n\n---\n\n";
      continue;
    }

    // Low relevance — snip ±SNIP_WINDOW lines around matches only
    const lines = content.split("\n");
    const snipRegex = new RegExp(
      [
        escapedSymbol,
        escapedRoot,
        ...searchKeywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      ].join("|"),
      "gi",
    );

    const ranges: { start: number; end: number }[] = [];
    lines.forEach((line, i) => {
      snipRegex.lastIndex = 0;
      if (snipRegex.test(line)) {
        ranges.push({
          start: Math.max(0, i - SNIP_WINDOW),
          end: Math.min(lines.length - 1, i + SNIP_WINDOW),
        });
      }
    });

    if (ranges.length === 0) continue;

    // Merge overlapping ranges
    const merged: { start: number; end: number }[] = [];
    ranges.sort((a, b) => a.start - b.start);
    let current = ranges[0];
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].start <= current.end + 1) {
        current.end = Math.max(current.end, ranges[i].end);
      } else {
        merged.push(current);
        current = ranges[i];
      }
    }
    merged.push(current);

    gapAnalysisBundle += `## SHARD: ${f}\n\n`;
    for (const range of merged) {
      gapAnalysisBundle += `### Lines ${range.start + 1}–${range.end + 1}\n\n`;
      gapAnalysisBundle += "```typescript\n";
      gapAnalysisBundle += lines.slice(range.start, range.end + 1).join("\n");
      gapAnalysisBundle += "\n```\n\n";
    }
    gapAnalysisBundle += "---\n\n";
  }

  return { gapSourceFiles, gapAnalysisBundle };
}
