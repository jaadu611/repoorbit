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
const SURROUNDING_LINES_BEFORE = 40; // enough to capture require() at top of file
const SURROUNDING_LINES_AFTER = 20; // enough to capture module.exports below fn

// ---------------------------------------------------------------------------
// DEPENDENCY MANIFEST CO-EXTRACTION
// ---------------------------------------------------------------------------
// package.json (and equivalents) have zero entries in graph.json — they are
// pure metadata and the dependency graph builder never links them to source
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

  extractedBlocks.push(
    `// =============================================================================\n`,
  );

  // =========================================================================
  // SECTION 6: Symbol & File Resolution
  // =========================================================================
  const symbolsPath = path.join(outDir, "symbols.json");
  // The notebook files stored in outDir are the repository source ground truth
  const notebooksMetaPath = path.join(outDir, "notebooks.json");
  const notebooksDir = outDir; // notebook_01, notebook_02, ... live here

  // ------------------------------------------------------------------
  // SECTION 4: Process context_files (from notebooks or direct read)
  // ------------------------------------------------------------------
  const cFiles: string[] = Array.isArray(pathBJson.context_files)
    ? pathBJson.context_files
    : [];

  if (cFiles.length > 0) {
    console.log(
      `[ContentBuilder] Reading ${cFiles.length} context_files from repository sources`,
    );

    let notebooksLookup: Array<{
      name: string;
      files: string[];
      localFiles: string[];
    }> = [];
    try {
      if (fs.existsSync(notebooksMetaPath)) {
        notebooksLookup = JSON.parse(
          fs.readFileSync(notebooksMetaPath, "utf-8"),
        );
      }
    } catch {}

    for (const relPath of cFiles) {
      if (!relPath) continue;

      // 1. Try local notebook files first
      let found = false;
      for (const nb of notebooksLookup) {
        const idx = nb.files.indexOf(relPath);
        if (idx !== -1) {
          const localPath = nb.localFiles[idx];
          if (fs.existsSync(localPath)) {
            const pairKey = `${localPath}|__file__`;
            if (processedPairs.has(pairKey)) {
              found = true;
              break;
            }
            processedPairs.add(pairKey);
            const raw = fs.readFileSync(localPath, "utf-8");
            const code = raw.includes("\n\n")
              ? raw.split("\n\n").slice(1).join("\n\n")
              : raw;
            extractedBlocks.push(`// --- Source: ${relPath} (notebook) ---`);
            extractedBlocks.push(code);
            found = true;
            break;
          }
        }
      }

      // 2. Fall back to repoRoot direct read
      if (!found) {
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
    }
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

  // =========================================================================
  // SECTION 5 (NEW): Dependency Manifest Co-Extraction
  // =========================================================================
  // Emitted ONCE before any symbols so every model reading this context file
  // sees the dependency versions first, before any function body it will fix.
  const manifestCoExtract = findDependencyManifest(repoRoot, repoRoot, 2);
  if (manifestCoExtract !== null) {
    const rel: string = manifestCoExtract.relPath as string;
    const content: string = manifestCoExtract.content as string;
    extractedBlocks.push(
      `\n// =============================================================================`,
    );
    extractedBlocks.push(`// DEPENDENCY MANIFEST: ${rel}`);
    extractedBlocks.push(
      `// Co-extracted automatically alongside the target symbols.`,
      `// IMPORTANT FOR CODING MODELS:`,
      `// Before choosing any option value for a third-party library call`,
      `// look up the installed version in this manifest first.`,
    );
    extractedBlocks.push(
      `// =============================================================================`,
    );
    extractedBlocks.push(content);

    const mfn: string = rel.replace(/[^a-zA-Z0-9_-]/g, "_");
    const manifestFileName = `dep_manifest_${mfn}.txt`;
    const manifestFilePath = path.join(contextDir, manifestFileName);
    fs.writeFileSync(
      manifestFilePath,
      `// Dependency Manifest: ${rel}\n\n${content}`,
      "utf-8",
    );
  } else {
    console.warn(
      `[buildDeepseekContext] No dependency manifest found in mirror. Models will not have version info.`,
    );
    extractedBlocks.push(
      `// [WARNING] No dependency manifest (package.json / Cargo.toml / go.mod etc.) found.`,
      `// Models MUST NOT guess option values for third-party libraries without version info.`,
      `// Use the NEED_MORE_CONTEXT protocol if you require dependency version information.`,
    );
  }

  // ------------------------------------------------------------------
  // SECTION 6a: Process context_files (prefer notebook local files, fallback to GitHub/direct)
  // ------------------------------------------------------------------
  const contextFiles: string[] = Array.isArray(pathBJson.context_files)
    ? pathBJson.context_files
    : [];

  let notebooksLookup2: Array<{ name: string; files: string[]; localFiles: string[] }> = [];
  try {
    if (fs.existsSync(notebooksMetaPath)) {
      notebooksLookup2 = JSON.parse(fs.readFileSync(notebooksMetaPath, "utf-8"));
    }
  } catch {}

  if (contextFiles.length > 0) {
    extractedBlocks.push(`\n// =============================================================================`);
    extractedBlocks.push(`// REPOSITORY SOURCE FILES`);
    extractedBlocks.push(`// =============================================================================`);

    for (const relPath of contextFiles) {
      const ext = path.extname(relPath).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext)) continue;

      // Try notebook local files first
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
          const lineCount = code.split("\n").length;

          extractedBlocks.push(`// --- Source: ${relPath} ---`);
          console.log(`[buildDeepseekContext] Staged notebook file: ${relPath} (${lineCount} lines)`);

          if (lineCount > SPLIT_LINE_THRESHOLD) {
            const safeName = relPath.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
            const splitFileName = `raw_${safeName}.js`;
            const splitFilePath = path.join(contextDir, splitFileName);
            fs.writeFileSync(splitFilePath, `// Raw source: ${relPath}\n\n${code}`, "utf-8");
            extractedBlocks.push(`// --- See: ${splitFileName} (${lineCount} lines) ---`);
          } else {
            extractedBlocks.push(code);
          }
          found = true;
          break;
        }
      }

      // Fallback to direct repo read
      if (!found) {
        const fullPath = path.join(repoRoot, relPath);
        if (!fs.existsSync(fullPath)) {
          extractedBlocks.push(`// [MISSING] ${relPath} not found`);
          console.warn(`[buildDeepseekContext] File not found: ${fullPath}`);
          continue;
        }
        const pairKey = `${fullPath}|__raw__`;
        if (processedPairs.has(pairKey)) continue;
        processedPairs.add(pairKey);
        const code = fs.readFileSync(fullPath, "utf-8");
        extractedBlocks.push(`// --- Source: ${relPath} (direct) ---`);
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

    const rawSourceFile: string | undefined =
      typeof symRequest.source_file === "string" &&
      symRequest.source_file.trim()
        ? symRequest.source_file.trim()
        : undefined;

    const explicitSourceFile = rawSourceFile ?? undefined;

    let candidateFiles: CandidateFile[] = [];

    if (explicitSourceFile) {
      const explicit: string = explicitSourceFile;
      // Check notebook local files first
      let resolvedFromNotebook = false;
      for (const nb of notebooksLookup2) {
        const idx = nb.files.indexOf(explicit);
        if (idx !== -1 && fs.existsSync(nb.localFiles[idx])) {
          candidateFiles = [{ fullPath: nb.localFiles[idx], relPath: explicit }];
          resolvedFromNotebook = true;
          break;
        }
      }

      if (!resolvedFromNotebook) {
        const fullPath = path.join(repoRoot, explicit);
        if (fs.existsSync(fullPath)) {
          candidateFiles = [{ fullPath, relPath: explicit }];
        } else {
          extractedBlocks.push(
            `// [WARN] source_file "${explicit}" not found — falling back to heuristic search`,
          );
          candidateFiles = resolveCandidateFiles(
            hint,
            symbolIndex,
            contextFiles,
            notebooksLookup2,
            repoRoot,
            explicit,
          );
        }
      }
    } else {
      candidateFiles = resolveCandidateFiles(
        hint,
        symbolIndex,
        contextFiles,
        notebooksLookup2,
        repoRoot,
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
      const rawKey = `${fullPath}|__raw__`;
      if (processedPairs.has(rawKey)) {
        extractedBlocks.push(
          `// (${hint} not isolated — full source already staged above)`,
        );
        console.warn(
          `[buildDeepseekContext] Could not isolate "${hint}" in ${relPath} but file already staged — skipping duplicate.`,
        );
        continue;
      }

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
        // Use the larger of 150 or SURROUNDING_LINES_BEFORE so require()
        // statements at the top of the file are always captured.
        const from = Math.max(
          0,
          centre - Math.max(150, SURROUNDING_LINES_BEFORE),
        );
        const to = Math.min(lines.length - 1, centre + 150);
        snippet =
          (from > 0 ? `// [truncated ${from} lines before...]\n` : "") +
          lines.slice(from, to + 1).join("\n") +
          (to < lines.length - 1
            ? `\n// [...truncated ${lines.length - to - 1} lines after]`
            : "");
      } else {
        const CAP = 200;
        snippet =
          lines.slice(0, CAP).join("\n") +
          (lines.length > CAP
            ? `\n// [...file truncated at ${CAP} lines — "${hint}" not found]`
            : "");
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

    // ---------------------------------------------------------------
    // SURROUNDING CONTEXT WINDOW — emitted for every extracted block
    // ---------------------------------------------------------------
    // We find the character offset of the extracted block in the full
    // source, then use extractSurroundingContext to get the lines
    // immediately before (require/imports) and after (module.exports).
    //
    // For small blocks we emit inline with labelled headers.
    // For large blocks we write to the split file with the prefix and
    // suffix included so the split file is self-contained.
    // ---------------------------------------------------------------
    for (const block of blocks) {
      const lineCount = block.split("\n").length;

      // Locate the block in the original source by exact string match.
      // This works because extractFunctionsFromCode uses code.slice() on
      // AST node offsets, so the block is a verbatim substring of code.
      const blockCharStart = code.indexOf(block);
      const blockCharEnd =
        blockCharStart >= 0 ? blockCharStart + block.length : -1;

      let prefixText = "";
      let suffixText = "";

      if (blockCharStart >= 0) {
        const surrounding = extractSurroundingContext(
          code,
          blockCharStart,
          blockCharEnd,
        );
        prefixText = surrounding.prefix.trim();
        suffixText = surrounding.suffix.trim();
      }

      if (lineCount > SPLIT_LINE_THRESHOLD) {
        const safeName = hint.replace(/[^a-zA-Z0-9_-]/g, "_");
        const splitFileName = `${safeName}.js`;
        const splitFilePath = path.join(contextDir, splitFileName);

        // Write prefix + body + suffix into the split file so it is
        // fully self-contained: the model sees require() stmts, the
        // function, and the module.exports line all in one file.
        const fullContent = [
          `// Source: ${relPath}`,
          `// Symbol: ${hint}`,
          ``,
          prefixText
            ? `// --- Module context before ${hint} (require/imports/module-level config) ---\n${prefixText}\n`
            : "",
          `// --- Symbol body ---`,
          block,
          suffixText
            ? `\n// --- Module context after ${hint} (exports/wiring) ---\n${suffixText}`
            : "",
        ]
          .filter((s) => s !== "")
          .join("\n");

        fs.writeFileSync(splitFilePath, fullContent, "utf-8");
        extractedBlocks.push(
          `// --- See: ${splitFileName} (${lineCount} lines, split to keep context readable) ---`,
        );
      } else {
        // Inline: emit prefix → body → suffix with clear section labels
        if (prefixText) {
          extractedBlocks.push(
            `// --- Module context before ${hint} (require/imports/module-level config) ---`,
          );
          extractedBlocks.push(prefixText);
        }
        extractedBlocks.push(block);
        if (suffixText) {
          extractedBlocks.push(
            `// --- Module context after ${hint} (exports/wiring) ---`,
          );
          extractedBlocks.push(suffixText);
        }
      }
    }
  }

  // =========================================================================
  // SECTION 7: Append gap-filled symbols (previous round requests)
  // =========================================================================
  const gapFiles = fs
    .readdirSync(contextDir)
    .filter(
      (f) => f.startsWith("gap_") && (f.endsWith(".js") || f.endsWith(".txt")),
    )
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
        const match = gapContent.match(/```typescript\n([\s\S]*?)```/);
        if (match !== null && match[1]) {
          const sourceCode: string = match[1];
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
                extractedBlocks.push(`// --- See: ${gapFile} (${lineCount} lines) ---`);
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
          extractedBlocks.push(
            `// [GAP FILE TOO LARGE — ${lineCount} lines] Could not isolate "${gapSymbol}". Check the full context upload for this symbol.`,
          );
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
