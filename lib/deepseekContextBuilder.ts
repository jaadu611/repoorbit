import * as fs from "fs";
import * as path from "path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
const traverse = (_traverse as any).default || _traverse;
import { execSync } from "child_process";

const CODE_EXTENSIONS = new Set([
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".rs",
  ".py",
  ".go",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".java",
  ".php",
  ".coffee",
]);

const SPLIT_LINE_THRESHOLD = 80;

const SOURCE_PRIORITY: RegExp[] = [
  /^lib\//,
  /^src\//,
  /^core\//,
  /^internal\//,
  /^pkg\//,
  /^cmd\//,
  /^server\//,
];
const TEST_FILE_RE = /\.(test|spec)\.[a-z]+$|\/test\/|\/tests?\//;

function sourceFilePriority(filePath: string): number {
  if (TEST_FILE_RE.test(filePath)) return SOURCE_PRIORITY.length + 1;
  for (let i = 0; i < SOURCE_PRIORITY.length; i++) {
    if (SOURCE_PRIORITY[i].test(filePath)) return i;
  }
  return SOURCE_PRIORITY.length;
}

export interface DeepseekContextResult {
  contextDir: string;
  contextText: string;
}

export function buildDeepseekContext(
  pathBJson: any,
  outDir: string,
): DeepseekContextResult {
  if (typeof pathBJson !== "object" || pathBJson === null) {
    throw new Error(
      `[buildDeepseekContext] pathBJson must be a plain object. Received: ${typeof pathBJson}`,
    );
  }

  // =========================================================================
  // Setup: create deepseek_context/ folder
  // =========================================================================
  const contextDir = path.join(outDir, "deepseek_context");
  fs.mkdirSync(contextDir, { recursive: true });

  // Only delete files that are NOT gap files from a previous round.
  for (const f of fs.readdirSync(contextDir)) {
    if (!f.startsWith("gap_")) {
      fs.unlinkSync(path.join(contextDir, f));
    }
  }

  const extractedBlocks: string[] = [];
  const processedPairs = new Set<string>(); // `${fullPath}|${hint}`

  const repoRoot = path.dirname(outDir);

  // =========================================================================
  // SECTION 1: Mission Metadata Header
  // =========================================================================
  extractedBlocks.push(
    `// =============================================================================`,
  );
  extractedBlocks.push(`// MISSION CONTEXT: ${pathBJson.intent || "FIX"}`);
  extractedBlocks.push(
    `// =============================================================================\n`,
  );


  // =========================================================================
  // SECTION 2: Logic Extraction (Removed - DeepSeek handles natively)
  // =========================================================================


  extractedBlocks.push(
    `// =============================================================================\n`,
  );

  // =========================================================================
  // SECTION 6: Symbol & File Resolution
  // =========================================================================
  const symbolsPath = path.join(outDir, "symbols.json");
  const mirrorDir = path.join(outDir, "source_mirror");

  // ------------------------------------------------------------------
  // Mirror missing — fall back to reading context_files from repo root
  // ------------------------------------------------------------------
  if (!fs.existsSync(mirrorDir)) {
    console.warn(
      `[ContentBuilder] Mirror directory not found at ${mirrorDir}. ` +
        `Falling back to reading context_files directly from repo root: ${repoRoot}`,
    );
    extractedBlocks.push(
      `// [WARNING] Source mirror missing — reading context_files directly from repo root.\n`,
    );

    const contextFiles: string[] = Array.isArray(pathBJson.context_files)
      ? pathBJson.context_files
      : [];

    for (const relPath of contextFiles) {
      const fullPath = path.join(repoRoot, relPath);
      const ext = path.extname(relPath).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext)) continue;
      if (!fs.existsSync(fullPath)) {
        extractedBlocks.push(
          `// [MISSING] ${relPath} not found at ${fullPath}`,
        );
        continue;
      }
      const pairKey = `${fullPath}|__file__`;
      if (processedPairs.has(pairKey)) continue;
      processedPairs.add(pairKey);
      const code = fs.readFileSync(fullPath, "utf-8");
      extractedBlocks.push(`// --- Source: ${relPath} (direct read) ---`);
      extractedBlocks.push(code);
    }

    const contextText = extractedBlocks.join("\n\n");
    const mainFile = path.join(contextDir, "context.js");
    fs.writeFileSync(mainFile, contextText, "utf-8");
    return { contextDir, contextText };
  }

  // ------------------------------------------------------------------
  // Load symbol index
  // ------------------------------------------------------------------
  let symbolIndex: Record<
    string,
    { defined_in: string; used_by_files: string }
  > = {};

  try {
    if (fs.existsSync(symbolsPath)) {
      symbolIndex = JSON.parse(fs.readFileSync(symbolsPath, "utf-8"));
    }
  } catch (err) {
    console.warn("Could not load symbols index:", err);
  }

  // ------------------------------------------------------------------
  // SECTION 6a: Process context_files that are source_mirror/ paths
  // These are raw files listed explicitly by NotebookLM in PATH B JSON.
  // They bypass the symbol extraction path and are included directly.
  // ------------------------------------------------------------------
  const contextFiles: string[] = Array.isArray(pathBJson.context_files)
    ? pathBJson.context_files
    : [];

  const mirrorPrefixedFiles = contextFiles.filter((f) =>
    f.startsWith("source_mirror/"),
  );

  if (mirrorPrefixedFiles.length > 0) {
    extractedBlocks.push(
      `\n// =============================================================================`,
    );
    extractedBlocks.push(`// RAW SOURCE MIRROR FILES (ground truth)`);
    extractedBlocks.push(
      `// =============================================================================`,
    );

    for (const mirrorRelPath of mirrorPrefixedFiles) {
      // e.g. "source_mirror/src/bearer.js" → absolute path
      const fullPath = path.join(outDir, mirrorRelPath);
      const ext = path.extname(mirrorRelPath).toLowerCase();

      if (!CODE_EXTENSIONS.has(ext)) continue;

      if (!fs.existsSync(fullPath)) {
        extractedBlocks.push(
          `// [MISSING] ${mirrorRelPath} not found at ${fullPath}`,
        );
        console.warn(`[buildDeepseekContext] Mirror file not found: ${fullPath}`);
        continue;
      }

      const pairKey = `${fullPath}|__raw__`;
      if (processedPairs.has(pairKey)) continue;
      processedPairs.add(pairKey);

      const code = fs.readFileSync(fullPath, "utf-8");
      const lineCount = code.split("\n").length;
      const originalPath = mirrorRelPath.replace(/^source_mirror\//, "");

      extractedBlocks.push(`// --- Raw Source: ${originalPath} ---`);
      console.log(
        `[buildDeepseekContext] Staged raw mirror file: ${mirrorRelPath} (${lineCount} lines)`,
      );

      if (lineCount > SPLIT_LINE_THRESHOLD) {
        const safeName = originalPath
          .replace(/[^a-zA-Z0-9_-]/g, "_")
          .replace(/_+/g, "_");
        const splitFileName = `raw_${safeName}.js`;
        const splitFilePath = path.join(contextDir, splitFileName);
        fs.writeFileSync(
          splitFilePath,
          `// Raw source: ${originalPath}\n\n${code}`,
          "utf-8",
        );
        extractedBlocks.push(
          `// --- See: ${splitFileName} (${lineCount} lines) ---`,
        );
      } else {
        extractedBlocks.push(code);
      }
    }
  }

  // ------------------------------------------------------------------
  // SECTION 6b: target_symbols — extract specific functions
  // ------------------------------------------------------------------
  const targetSymbols = Array.isArray(pathBJson.target_symbols)
    ? pathBJson.target_symbols
    : [];

  for (const symRequest of targetSymbols) {
    const hint = symRequest.name_hint || symRequest.name;
    if (!hint) continue;

    extractedBlocks.push(
      `// --- Symbol: "${hint}" | Role: ${symRequest.role || "unspecified"} | Type: ${symRequest.type || "unknown"} ---`,
    );

    // ------------------------------------------------------------------
    // Resolve source file — explicit source_file wins, heuristic fallback.
    // Also handle source_mirror/ prefixed source_file paths from PATH B JSON.
    // ------------------------------------------------------------------
    const rawSourceFile: string | undefined =
      typeof symRequest.source_file === "string" &&
      symRequest.source_file.trim()
        ? symRequest.source_file.trim()
        : undefined;

    // Strip source_mirror/ prefix if present — we resolve via mirrorDir
    const explicitSourceFile = rawSourceFile?.startsWith("source_mirror/")
      ? rawSourceFile.replace(/^source_mirror\//, "")
      : rawSourceFile;

    let candidateFiles: CandidateFile[];

    if (explicitSourceFile) {
      const fullPath = path.join(mirrorDir, explicitSourceFile);
      if (fs.existsSync(fullPath)) {
        candidateFiles = [{ fullPath, relPath: explicitSourceFile }];
      } else {
        extractedBlocks.push(
          `// [WARN] source_file "${explicitSourceFile}" not found in mirror — falling back to heuristic search`,
        );
        candidateFiles = resolveCandidateFiles(
          hint,
          symbolIndex,
          contextFiles.filter((f) => !f.startsWith("source_mirror/")),
          mirrorDir,
          explicitSourceFile, // Pass explicit file to handle mappings
        );
      }
    } else {
      candidateFiles = resolveCandidateFiles(
        hint,
        symbolIndex,
        contextFiles.filter((f) => !f.startsWith("source_mirror/")),
        mirrorDir,
      );
    }

    if (candidateFiles.length === 0) {
      extractedBlocks.push(`// [NOT FOUND] No source file found for "${hint}"`);
      continue;
    }

    candidateFiles.sort(
      (a, b) => sourceFilePriority(a.relPath) - sourceFilePriority(b.relPath),
    );

    const { fullPath, relPath } = candidateFiles[0];

    const pairKey = `${fullPath}|${hint}`;
    if (processedPairs.has(pairKey)) {
      extractedBlocks.push(
        `// (already included above: ${hint} from ${relPath})`,
      );
      continue;
    }
    processedPairs.add(pairKey);

    const code = fs.readFileSync(fullPath, "utf-8");
    const blocks = extractFunctionsFromCode(code, hint);

    extractedBlocks.push(`// --- Source: ${relPath} ---`);

    if (blocks.length === 0) {
      // If this file was already staged via source_mirror/ (Section 6a), don't duplicate it
      const rawKey = `${fullPath}|__raw__`;
      if (processedPairs.has(rawKey)) {
        extractedBlocks.push(
          `// (${hint} not isolated — full source already staged above as source_mirror file)`,
        );
        console.warn(
          `[buildDeepseekContext] Could not isolate "${hint}" in ${relPath} but file already staged — skipping duplicate.`,
        );
        continue;
      }

      // Extract a windowed fallback (±150 lines around the hint) rather than the full file
      const lines = code.split("\n");
      const lowerHint = hint.toLowerCase();
      const hitLines = lines
        .map((l, i) => (l.toLowerCase().includes(lowerHint) ? i : -1))
        .filter((i) => i !== -1);

      console.warn(
        `[buildDeepseekContext] No functions matched "${hint}" in ${relPath}${hitLines.length > 0 ? ` — using windowed fallback around line ${hitLines[0]}` : " — emitting capped head"}.`,
      );

      let snippet: string;
      if (hitLines.length > 0) {
        const centre = hitLines[0];
        const from = Math.max(0, centre - 150);
        const to = Math.min(lines.length - 1, centre + 150);
        snippet =
          (from > 0 ? `// [truncated ${from} lines before...]\n` : "") +
          lines.slice(from, to + 1).join("\n") +
          (to < lines.length - 1 ? `\n// [...truncated ${lines.length - to - 1} lines after]` : "");
      } else {
        // No hit at all — emit only the first 200 lines as a head
        const CAP = 200;
        snippet =
          lines.slice(0, CAP).join("\n") +
          (lines.length > CAP ? `\n// [...file truncated at ${CAP} lines — "${hint}" not found]` : "");
      }

      const safeName = hint.replace(/[^a-zA-Z0-9_-]/g, "_");
      const splitFileName = `${safeName}.js`;
      const splitFilePath = path.join(contextDir, splitFileName);
      fs.writeFileSync(
        splitFilePath,
        `// Source: ${relPath}\n// Symbol: ${hint} (windowed fallback)\n\n${snippet}`,
        "utf-8",
      );
      extractedBlocks.push(
        `// --- See: ${splitFileName} (windowed context around "${hint}") ---`,
      );
      continue;
    }

    for (const block of blocks) {
      const lineCount = block.split("\n").length;

      if (lineCount > SPLIT_LINE_THRESHOLD) {
        const safeName = hint.replace(/[^a-zA-Z0-9_-]/g, "_");
        const splitFileName = `${safeName}.js`;
        const splitFilePath = path.join(contextDir, splitFileName);
        fs.writeFileSync(
          splitFilePath,
          `// Source: ${relPath}\n// Symbol: ${hint}\n\n${block}`,
          "utf-8",
        );
        extractedBlocks.push(
          `// --- See: ${splitFileName} (${lineCount} lines, split to keep context readable) ---`,
        );
      } else {
        extractedBlocks.push(block);
      }
    }

  }

  // =========================================================================
  // SECTION 7: Append gap-filled symbols (previous round requests)
  // =========================================================================
  const gapFiles = fs
    .readdirSync(contextDir)
    .filter((f) => f.startsWith("gap_") && (f.endsWith(".js") || f.endsWith(".txt")))
    .sort();

  if (gapFiles.length > 0) {
    extractedBlocks.push(
      `\n// =============================================================================`,
    );
    extractedBlocks.push(
      `// GAP-FILLED SYMBOLS (fetched on previous round at DeepSeek's request)`,
    );
    extractedBlocks.push(
      `// =============================================================================`,
    );

    for (const gapFile of gapFiles) {
      const gapFilePath = path.join(contextDir, gapFile);
      const gapContent = fs.readFileSync(gapFilePath, "utf-8");

      const headerMatch = gapContent.match(
        /^\/\/ Gap-filled: (\S+) from (\S+)/m,
      );
      const gapSymbol =
        headerMatch?.[1] ?? gapFile.replace(/^gap_/, "").replace(/\.js$/, "");
      const gapSourceFile = headerMatch?.[2];

      extractedBlocks.push(`// --- Gap-filled symbol: "${gapSymbol}" ---`);

      let extracted = false;
      if (gapSourceFile) {
        const sourceBlockMatch = gapContent.match(
          /```typescript\n([\s\S]*?)```/,
        );
        if (sourceBlockMatch) {
          const sourceCode = sourceBlockMatch[1];
          const blocks = extractFunctionsFromCode(sourceCode, gapSymbol);
          if (blocks.length > 0) {
            extractedBlocks.push(`// Source: ${gapSourceFile} (gap-filled)`);
            for (const block of blocks) {
              const lineCount = block.split("\n").length;
              if (lineCount > SPLIT_LINE_THRESHOLD) {
                const trimmedPath = path.join(contextDir, gapFile);
                fs.writeFileSync(
                  trimmedPath,
                  `// Gap-filled: ${gapSymbol} from ${gapSourceFile}\n\n${block}`,
                  "utf-8",
                );
                extractedBlocks.push(
                  `// --- See: ${gapFile} (${lineCount} lines) ---`,
                );
              } else {
                extractedBlocks.push(block);
              }
            }
            extracted = true;
          }
        }
      }

      if (!extracted) {
        const lineCount = gapContent.split("\n").length;
        if (lineCount <= SPLIT_LINE_THRESHOLD * 2) {
          extractedBlocks.push(gapContent);
        } else {
          console.warn(
            `[buildDeepseekContext] Could not extract "${gapSymbol}" from gap file — ` +
              `file is ${lineCount} lines. DeepSeek will receive it as a separate upload ` +
              `but it may contain noise. Consider fixing name_hint in PATH B JSON.`,
          );
          extractedBlocks.push(
            `// [GAP FILE TOO LARGE — ${lineCount} lines] Could not extract "${gapSymbol}". ` +
              `Check that name_hint in PATH B JSON is an exact function name not a filename.`,
          );
          const sourceBlockMatch = gapContent.match(
            /```typescript\n([\s\S]*?)```/,
          );
          if (sourceBlockMatch) {
            fs.writeFileSync(
              gapFilePath,
              `// Gap-filled: ${gapSymbol} from ${gapSourceFile ?? "unknown"}\n\n${sourceBlockMatch[1]}`,
              "utf-8",
            );
            extractedBlocks.push(
              `// Trimmed to direct source block — see ${gapFile}`,
            );
          }
        }
      }
    }
  }

  // =========================================================================
  // Write main context file and return
  // =========================================================================
  const mainContextText = extractedBlocks.join("\n\n");
  const mainFile = path.join(contextDir, "context.js");
  fs.writeFileSync(mainFile, mainContextText, "utf-8");

  return { contextDir, contextText: mainContextText };
}

// =============================================================================
// Helpers
// =============================================================================

interface CandidateFile {
  fullPath: string;
  relPath: string;
}

function resolveCandidateFiles(
  hint: string,
  symbolIndex: Record<string, { defined_in: string; used_by_files: string }>,
  contextFiles: string[],
  mirrorDir: string,
  explicitFileHint?: string,
): CandidateFile[] {
  const candidates: CandidateFile[] = [];
  const seen = new Set<string>();

  const addCandidate = (relPath: string) => {
    if (!relPath) return;
    const ext = path.extname(relPath).toLowerCase();
    // Allow .coffee etc
    if (!CODE_EXTENSIONS.has(ext) && ext !== ".coffee") return;
    const fullPath = path.join(mirrorDir, relPath);
    if (!fs.existsSync(fullPath)) return;
    if (seen.has(fullPath)) return;
    seen.add(fullPath);
    candidates.push({ fullPath, relPath });
  };

  // Try to resolve explicit hint with fuzzy mapping (e.g. lib/foo.js -> _src/lib/foo.coffee)
  if (explicitFileHint) {
    addCandidate(explicitFileHint);
    if (candidates.length === 0) {
      const base = explicitFileHint.replace(/\.[a-z0-9]+$/, "");
      const extensions = [".ts", ".js", ".coffee", ".py", ".go", ".rs"];
      const prefixes = ["", "src/", "_src/", "lib/"];
      
      for (const p of prefixes) {
        for (const ext of extensions) {
          // try removing common prefixes from base too
          const cleanBase = base.replace(/^(src|lib|_src)\//, "");
          addCandidate(path.join(p, base + ext));
          addCandidate(path.join(p, cleanBase + ext));
        }
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(symbolIndex, hint)) {
    addCandidate(symbolIndex[hint].defined_in);
  }

  const hintLower = hint.toLowerCase();
  const exactMatches: string[] = [];
  const substringMatches: string[] = [];

  for (const [sym, info] of Object.entries(symbolIndex)) {
    const symLower = sym.toLowerCase();
    if (symLower === hintLower) {
      exactMatches.push(info.defined_in);
    } else if (symLower.includes(hintLower) || hintLower.includes(symLower)) {
      substringMatches.push(info.defined_in);
    }
  }

  if (exactMatches.length > 0) {
    exactMatches.forEach(addCandidate);
  } else {
    substringMatches.forEach(addCandidate);
  }

  if (fs.existsSync(mirrorDir) && !hint.includes(" ")) {
    try {
      const rgMatches = execSync(`rg -l "\\b${hint}\\b" .`, {
        cwd: mirrorDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      })
        .split("\n")
        .filter(Boolean);
      rgMatches.forEach(addCandidate);
    } catch {}
  }

  for (const f of contextFiles) {
    addCandidate(f);
  }

  const nonTest = candidates.filter((c) => !TEST_FILE_RE.test(c.relPath));
  return nonTest.length > 0 ? nonTest : candidates;
}

function extractFunctionsFromCode(code: string, hint: string): string[] {
  const exactBlocks: string[] = [];
  const substringBlocks: string[] = [];
  const lowerHint = hint.toLowerCase();

  const isExactMatch = (name: string) => name.toLowerCase() === lowerHint;
  const isSubstringMatch = (name: string) => {
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

    traverse(ast, {
      // FIX: ClassDeclaration was missing — ES6 classes like Bearer, Basic,
      // Permit were not being extracted, causing whole-file fallback every time.
      ClassDeclaration(p: any) {
        const name = p.node.id?.name;
        if (!name) return;
        const block = code.slice(p.node.start!, p.node.end!);
        if (isExactMatch(name)) exactBlocks.push(block);
        else if (isSubstringMatch(name)) substringBlocks.push(block);
      },
      FunctionDeclaration(p: any) {
        const name = p.node.id?.name;
        if (!name) return;
        const block = code.slice(p.node.start!, p.node.end!);
        if (isExactMatch(name)) exactBlocks.push(block);
        else if (isSubstringMatch(name)) substringBlocks.push(block);
      },
      VariableDeclarator(p: any) {
        if (
          !p.node.init ||
          (p.node.init.type !== "FunctionExpression" &&
            p.node.init.type !== "ArrowFunctionExpression")
        )
          return;
        const id = p.node.id;
        if (id.type !== "Identifier") return;
        const name = id.name;
        const decl = p.parentPath.node;
        if (decl.type !== "VariableDeclaration") return;
        const block = code.slice(decl.start!, decl.end!);
        if (isExactMatch(name)) exactBlocks.push(block);
        else if (isSubstringMatch(name)) substringBlocks.push(block);
      },
      AssignmentExpression(p: any) {
        if (
          p.node.right.type !== "FunctionExpression" &&
          p.node.right.type !== "ArrowFunctionExpression"
        )
          return;
        const left = p.node.left;
        let name = "";
        if (
          left.type === "MemberExpression" &&
          left.property.type === "Identifier"
        ) {
          name = left.property.name;
        } else if (left.type === "Identifier") {
          name = left.name;
        }
        if (!name) return;
        const block = code.slice(p.node.start!, p.node.end!);
        if (isExactMatch(name)) exactBlocks.push(block);
        else if (isSubstringMatch(name)) substringBlocks.push(block);
      },
      ClassMethod(p: any) {
        const id = p.node.key;
        if (id.type !== "Identifier") return;
        const name = id.name;
        const block = code.slice(p.node.start!, p.node.end!);
        if (isExactMatch(name)) exactBlocks.push(block);
        else if (isSubstringMatch(name)) substringBlocks.push(block);
      },
    });

    if (exactBlocks.length > 0) return exactBlocks;
    if (substringBlocks.length > 0) return substringBlocks;
    return [];
  } catch (err) {
    // If Babel fails, we are likely in a non-JS file (e.g. C/C++/Go)
    // Use an aggressive regex-based extraction to find function bodies
    const lines = code.split("\n");
    const found: string[] = [];
    const lowerHint = hint.toLowerCase();

    // 1. Precise match (likely for C functions/macros/structs)
    // Matches: int some_function(args) { ... }
    //          extern void* some_func(void) {
    //          #define hint ...
    //          struct hint { ... }
    const cDefPatterns = [
      new RegExp(`^[^\\/*\\n]*\\b${hint}\\b\\s*\\([^;]*$`, "m"), // Function definition start
      new RegExp(`^\\s*\\b${hint}\\b\\s*[:=].*->`, "m"),        // CoffeeScript
      new RegExp(`^#\\s*define\\s+${hint}\\b`, "m"),              // Macro
      new RegExp(`^(struct|union|enum)\\s+${hint}\\b`, "m"),     // Type definition
      new RegExp(`^typedef\\s+.*\\b${hint}\\s*;`, "m"),           // Typedef
    ];

    let match: RegExpExecArray | null = null;
    for (const pattern of cDefPatterns) {
      match = pattern.exec(code);
      if (match) break;
    }

    if (match) {
      const idx = match.index;
      // Find where the block ends via brace matching
      let braceSearchIdx = idx;
      while (
        braceSearchIdx < code.length &&
        code[braceSearchIdx] !== "{" &&
        code[braceSearchIdx] !== ";" &&
        code[braceSearchIdx] !== "\n" // for simple macros
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
        if (finalIdx !== -1) {
          found.push(code.slice(idx, finalIdx + 1));
        }
      } else {
        // Just the line (e.g. macro or typedef)
        const endOfLine = code.indexOf("\n", idx);
        found.push(code.slice(idx, endOfLine !== -1 ? endOfLine : code.length));
      }
    }

    if (found.length > 0) return found;

    // 2. Loose fallback (substring grep with context)
    // If we can't find a clean block, we'll try to find the lines containing the hint
    // and grab some context around it
    const mathcingLines = lines
      .map((l, idx) => (l.toLowerCase().includes(lowerHint) ? idx : -1))
      .filter((i) => i !== -1);

    if (mathcingLines.length > 0) {
      const firstLine = Math.max(0, mathcingLines[0] - 10);
      const lastLine = Math.min(lines.length - 1, mathcingLines[mathcingLines.length - 1] + 50);
      return [`// [FALLBACK] Substring match for "${hint}"\n` + lines.slice(firstLine, lastLine + 1).join("\n")];
    }

    return [];
  }
}