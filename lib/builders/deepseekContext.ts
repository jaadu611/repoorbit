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

// ---------------------------------------------------------------------------
// SURROUNDING CONTEXT WINDOW
// ---------------------------------------------------------------------------
// When we extract a specific symbol (e.g. parseExtendedQueryString), we only
// get the function body. The coding models therefore never see the require()
// or import statements at the top of the file — the lines that tell them
// which external modules are in scope and in what version.
//
// Without this, a model fixing parseExtendedQueryString cannot know that `qs`
// is even a variable in scope, let alone what major version it is. This causes
// models to guess option values (false, -1) instead of the correct documented
// value (Infinity). This happened on the express arrayLimit bug.
//
// Fix: after extracting a symbol block, we capture the N lines immediately
// before it in the source file (to get require/import and module-level config)
// and N lines after it (to get module.exports and sibling wiring). These are
// emitted as labelled sections so the model sees the full calling context.
const SURROUNDING_LINES_BEFORE = 100; // Increased to capture more context
const SURROUNDING_LINES_AFTER = 50;  // Increased to capture more context

// ---------------------------------------------------------------------------
// DEPENDENCY MANIFEST CO-EXTRACTION
// ---------------------------------------------------------------------------
// package.json (and equivalents) are pure metadata and the dependency 
// graph builder never links them to source files.
// files. The context extractor therefore never pulls them in automatically,
// even when the target function's correctness depends entirely on knowing
// which version of a third-party library is installed.
//
// Real example: parseExtendedQueryString calls qs.parse(). The correct value
// for the arrayLimit option depends on which major version of `qs` is used.
// Without package.json, both DeepSeek and Qwen guessed (false and -1) instead
// of the correct documented value (Infinity). The fix is to always co-extract
// the nearest dependency manifest before emitting any symbol blocks.
const DEPENDENCY_MANIFEST_NAMES = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "requirements.txt",
  "pyproject.toml",
  "Gemfile",
  "composer.json",
  "build.gradle",
  "pom.xml",
];

/**
 * Extracts the "header" of a file (imports, requires, top-level comments).
 * This ensures the model always sees what modules are in scope.
 */
function extractFileHeader(code: string, maxLines = 100): string {
  const lines = code.split("\n");
  const headerLines: string[] = [];
  
  // Basic heuristic: stop at the first line that doesn't look like an import,
  // require, comment, or whitespace.
  const importRegex = /^(import|require|const\s+\w+\s*=\s*require|from\s+['"]|@import|use\s+|mod\s+|#include|package\s+)/;
  const commentRegex = /^(\/|\*|#|--)/;
  const whitespaceRegex = /^\s*$/;

  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    const line = lines[i].trim();
    if (line === "" || importRegex.test(line) || commentRegex.test(line) || whitespaceRegex.test(line)) {
      headerLines.push(lines[i]);
    } else {
      // If we hit real code, we might want to include it if it's very early, 
      // but let's be conservative to avoid noise. 
      // Actually, let's just take the first N lines anyway if it's really the top of the file.
      break;
    }
  }

  if (headerLines.length === 0 && lines.length > 0) {
    // If our heuristic failed but there's content, just take the first 20 lines
    return lines.slice(0, 20).join("\n") + "\n// [... header heuristic ended ...]\n";
  }

  return headerLines.join("\n");
}

/**
 * Walks up from `startDir` toward `repoRoot` root looking for a dependency
 * manifest. Returns the first one found (relative path + content), or null.
 * maxDepth prevents walking above the repo root.
 */
function findDependencyManifest(
  startDir: string,
  repoRoot: string,
  maxDepth = 4,
): { relPath: string; content: string } | null {
  let dir = startDir;
  const root = path.resolve(repoRoot);

  for (let depth = 0; depth < maxDepth; depth++) {
    for (const name of DEPENDENCY_MANIFEST_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        const relPath = path.relative(root, candidate);
        const content = fs.readFileSync(candidate, "utf-8");
        return { relPath, content };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    if (!path.resolve(dir).startsWith(root)) break; // above root
    dir = parent;
  }
  return null;
}

/**
 * Given the full source text and the character offsets of an extracted symbol
 * block, returns the SURROUNDING_LINES_BEFORE lines before and
 * SURROUNDING_LINES_AFTER lines after the block as separate strings.
 *
 * We return prefix and suffix separately so the caller can label each section
 * distinctly ("module context before" vs "module context after"), preserving
 * the model's ability to distinguish require/imports from exports/wiring.
 */
function extractSurroundingContext(
  fullCode: string,
  blockStart: number,
  blockEnd: number,
): { prefix: string; suffix: string } {
  const lines = fullCode.split("\n");

  // Build line index: map each line to its starting character offset so we
  // can convert Babel AST node.start/node.end offsets to line numbers.
  let charCount = 0;
  const lineStartOffsets: number[] = [];
  for (const line of lines) {
    lineStartOffsets.push(charCount);
    charCount += line.length + 1; // +1 for \n
  }

  // Find start line index
  let startLine = 0;
  for (let i = 0; i < lineStartOffsets.length; i++) {
    if (
      lineStartOffsets[i] <= blockStart &&
      (i === lineStartOffsets.length - 1 ||
        lineStartOffsets[i + 1] > blockStart)
    ) {
      startLine = i;
      break;
    }
  }

  // Find end line index
  let endLine = startLine;
  for (let i = startLine; i < lineStartOffsets.length; i++) {
    if (
      lineStartOffsets[i] <= blockEnd &&
      (i === lineStartOffsets.length - 1 || lineStartOffsets[i + 1] > blockEnd)
    ) {
      endLine = i;
      break;
    }
  }

  const prefixStart = Math.max(0, startLine - SURROUNDING_LINES_BEFORE);
  const suffixEnd = Math.min(
    lines.length - 1,
    endLine + SURROUNDING_LINES_AFTER,
  );

  const prefixLines = lines.slice(prefixStart, startLine);
  const suffixLines = lines.slice(endLine + 1, suffixEnd + 1);

  // Omission notes tell the model there is more code outside this window
  const prefixNote =
    prefixStart > 0 ? `// [... ${prefixStart} lines before omitted ...]\n` : "";
  const suffixNote =
    suffixEnd < lines.length - 1
      ? `\n// [... ${lines.length - 1 - suffixEnd} lines after omitted ...]`
      : "";

  return {
    prefix: prefixNote + prefixLines.join("\n"),
    suffix: suffixLines.join("\n") + suffixNote,
  };
}

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

  let blockIndex = 0;
  function writeBlock(name: string, content: string, ext = ".txt") {
    const idx = String(blockIndex++).padStart(3, "0");
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
    const fileName = `${idx}_${safeName}${ext}`;
    const filePath = path.join(contextDir, fileName);
    fs.writeFileSync(filePath, content, "utf-8");
    console.log(`[buildDeepseekContext] Wrote block: ${fileName}`);
    return fileName;
  }

  const repoRoot = outDir;
  const processedPairs = new Set<string>(); // `${fullPath}|${hint}`

  // =========================================================================
  // SECTION 1: Mission Metadata Header
  // =========================================================================
  writeBlock("mission_metadata", 
    `// =============================================================================\n` +
    `// MISSION CONTEXT: ${pathBJson.intent || "FIX"}\n` +
    `// =============================================================================\n`
  );

  // =========================================================================
  // SECTION 5: Dependency Manifest Co-Extraction
  // =========================================================================
  const manifestCoExtract = findDependencyManifest(repoRoot, repoRoot, 2);
  if (manifestCoExtract !== null) {
    const rel: string = manifestCoExtract.relPath as string;
    const content: string = manifestCoExtract.content as string;
    writeBlock(`dep_manifest_${rel.replace(/[^a-zA-Z0-9_-]/g, "_")}`, 
      `// Dependency Manifest: ${rel}\n\n${content}`
    );

    const rootPackageJson = path.join(repoRoot, "package.json");
    if (fs.existsSync(rootPackageJson) && rel !== "package.json") {
       writeBlock("root_package_json", fs.readFileSync(rootPackageJson, "utf-8"));
    }
  }

  // ------------------------------------------------------------------
  // SECTION 6a: Process context_files
  // ------------------------------------------------------------------
  const contextFiles: string[] = Array.isArray(pathBJson.context_files)
    ? pathBJson.context_files
    : [];

  let notebooksLookup2: Array<{ name: string; files: string[]; localFiles: string[] }> = [];
  try {
    const notebooksMetaPath = path.join(outDir, "notebooks.json");
    if (fs.existsSync(notebooksMetaPath)) {
      notebooksLookup2 = JSON.parse(fs.readFileSync(notebooksMetaPath, "utf-8"));
    }
  } catch {}

  for (const relPath of contextFiles) {
    const ext = path.extname(relPath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) continue;

    let found = false;
    for (const nb of notebooksLookup2) {
      const idx = nb.files.indexOf(relPath);
      if (idx !== -1 && fs.existsSync(nb.localFiles[idx])) {
        const localPath = nb.localFiles[idx];
        const pairKey = `${localPath}|__raw__`;
        if (processedPairs.has(pairKey)) continue;
        processedPairs.add(pairKey);

        const raw = fs.readFileSync(localPath, "utf-8");
        const code = raw.includes("\n\n") ? raw.split("\n\n").slice(1).join("\n\n") : raw;
        writeBlock(`source_${relPath}`, `// Source: ${relPath}\n\n${code}`, ext);
        found = true;
        break;
      }
    }

    if (!found) {
      const fullPath = path.join(repoRoot, relPath);
      if (fs.existsSync(fullPath)) {
        const pairKey = `${fullPath}|__raw__`;
        if (processedPairs.has(pairKey)) continue;
        processedPairs.add(pairKey);
        writeBlock(`source_${relPath}`, `// Source: ${relPath} (direct)\n\n${fs.readFileSync(fullPath, "utf-8")}`, ext);
      }
    }
  }

  // ------------------------------------------------------------------
  // SECTION 6b: target_symbols
  // ------------------------------------------------------------------
  const targetSymbols = Array.isArray(pathBJson.target_symbols)
    ? pathBJson.target_symbols
    : [];

  for (const symRequest of targetSymbols) {
    const hint = symRequest.name_hint || symRequest.name;
    if (!hint) continue;

    const rawSourceFile = typeof symRequest.source_file === "string" ? symRequest.source_file.trim() : undefined;
    let candidateFiles: CandidateFile[] = [];

    if (rawSourceFile) {
      const explicit = rawSourceFile;
      let resolved = false;
      for (const nb of notebooksLookup2) {
        const idx = nb.files.indexOf(explicit);
        if (idx !== -1 && fs.existsSync(nb.localFiles[idx])) {
          candidateFiles = [{ fullPath: nb.localFiles[idx], relPath: explicit }];
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        const fullPath = path.join(repoRoot, explicit);
        if (fs.existsSync(fullPath)) candidateFiles = [{ fullPath, relPath: explicit }];
      }
    }

    if (candidateFiles.length === 0) {
      candidateFiles = resolveCandidateFiles(hint, {}, contextFiles, notebooksLookup2, repoRoot);
    }

    if (candidateFiles.length > 0) {
      const { fullPath, relPath } = candidateFiles[0];
      const pairKey = `${fullPath}|${hint}`;
      if (processedPairs.has(pairKey)) continue;
      processedPairs.add(pairKey);

      const code = fs.readFileSync(fullPath, "utf-8");
      const blocks = extractFunctionsFromCode(code, hint);
      
      if (blocks.length > 0) {
        for (const block of blocks) {
          writeBlock(`symbol_${hint}`, `// Source: ${relPath}\n// Symbol: ${hint}\n\n${block}`, ".js");
        }
      } else {
        // Fallback for symbols that couldn't be parsed
        writeBlock(`symbol_${hint}_fallback`, `// Source: ${relPath}\n// Symbol: ${hint} (fallback)\n\n${code.slice(0, 5000)}`, ".js");
      }
    }
  }

  // =========================================================================
  // SECTION 7: Gap-filled symbols
  // =========================================================================
  const gapFiles = fs.readdirSync(contextDir).filter(f => f.startsWith("gap_")).sort();
  for (const gapFile of gapFiles) {
    const gapContent = fs.readFileSync(path.join(contextDir, gapFile), "utf-8");
    writeBlock(`gap_${gapFile}`, gapContent);
  }

  return { contextDir, contextText: "Individual context blocks staged." };
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
  symbolIndex: Record<string, any>,
  contextFiles: string[],
  notebooksLookup: Array<{ name: string; files: string[]; localFiles: string[] }>,
  repoRoot: string,
  explicitFileHint?: string,
): CandidateFile[] {
  const candidates: CandidateFile[] = [];
  const seen = new Set<string>();

  const addCandidate = (relPath: string) => {
    if (!relPath) return;
    const ext = path.extname(relPath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext) && ext !== ".coffee") return;

    // 1. Try notebooks first
    for (const nb of notebooksLookup) {
      const idx = nb.files.indexOf(relPath);
      if (idx !== -1 && fs.existsSync(nb.localFiles[idx])) {
        const fullPath = nb.localFiles[idx];
        if (seen.has(fullPath)) return;
        seen.add(fullPath);
        candidates.push({ fullPath, relPath });
        return;
      }
    }

    // 2. Fallback to direct repo read
    const repoPath = path.join(repoRoot, relPath);
    if (fs.existsSync(repoPath)) {
      if (seen.has(repoPath)) return;
      seen.add(repoPath);
      candidates.push({ fullPath: repoPath, relPath });
    }
  };

  if (explicitFileHint) {
    addCandidate(explicitFileHint);
    if (candidates.length === 0) {
      const base = explicitFileHint.replace(/\.[a-z0-9]+$/, "");
      const extensions = [".ts", ".js", ".coffee", ".py", ".go", ".rs"];
      const prefixes = ["", "src/", "_src/", "lib/"];
      for (const p of prefixes) {
        for (const ext of extensions) {
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

  if (fs.existsSync(repoRoot) && !hint.includes(" ")) {
    try {
      // If repoRoot still contains files (e.g. was direct read), search it
      const rgMatches = execSync(`rg -l "\\b${hint}\\b" .`, {
        cwd: repoRoot,
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
    const lines = code.split("\n");
    const found: string[] = [];
    const lowerHint = hint.toLowerCase();

    const cDefPatterns = [
      new RegExp(`^[^\\/*\\n]*\\b${hint}\\b\\s*\\([^;]*$`, "m"),
      new RegExp(`^\\s*\\b${hint}\\b\\s*[:=].*->`, "m"),
      new RegExp(`^#\\s*define\\s+${hint}\\b`, "m"),
      new RegExp(`^(struct|union|enum)\\s+${hint}\\b`, "m"),
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
        code[braceSearchIdx] !== ";" &&
        code[braceSearchIdx] !== "\n"
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
        const endOfLine = code.indexOf("\n", idx);
        found.push(code.slice(idx, endOfLine !== -1 ? endOfLine : code.length));
      }
    }

    if (found.length > 0) return found;

    const matchingLines = lines
      .map((l, idx) => (l.toLowerCase().includes(lowerHint) ? idx : -1))
      .filter((i) => i !== -1);

    if (matchingLines.length > 0) {
      const firstLine = Math.max(0, matchingLines[0] - 10);
      const lastLine = Math.min(
        lines.length - 1,
        matchingLines[matchingLines.length - 1] + 50,
      );
      return [
        `// [FALLBACK] Substring match for "${hint}"\n` +
          lines.slice(firstLine, lastLine + 1).join("\n"),
      ];
    }

    return [];
  }
}
