import path from "path";
import fs from "fs";
import { execSync } from "child_process";

import { GapSearchResult } from "@/lib/types";

export function searchGapFiles(
  outDir: string,
  targetFile: string,
  anchorFile: string,
  targetSymbol: string,
  searchKeywords: string[],
  maxFiles = 50,
): string[] {
  const scored = new Map<string, GapSearchResult>();

  const addScore = (filePath: string, delta: number, reason: string) => {
    const abs = path.join(outDir, filePath);
    if (!fs.existsSync(abs)) return;
    const existing = scored.get(filePath);
    if (existing) {
      existing.score += delta;
      existing.reason += `, ${reason}`;
    } else {
      scored.set(filePath, { filePath, score: delta, reason });
    }
  };

  try {
    const targetBaseName = path.basename(targetFile);
    const anchorBaseName = path.basename(anchorFile);

    const targetFileCmd = `rg -l -F "${targetBaseName}" -g "*.txt" .`;
    try {
      const results = execSync(targetFileCmd, {
        cwd: outDir,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      })
        .split("\n")
        .filter(Boolean);
      results.forEach((f) =>
        addScore(f, 100, `exact target_file match: ${targetBaseName}`),
      );
    } catch (_) {}

    const anchorFileCmd = `rg -l -F "${anchorBaseName}" -g "*.txt" .`;
    try {
      const results = execSync(anchorFileCmd, {
        cwd: outDir,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      })
        .split("\n")
        .filter(Boolean);
      results.forEach((f) =>
        addScore(f, 80, `exact anchor_file match: ${anchorBaseName}`),
      );
    } catch (_) {}

    if (targetFile !== targetBaseName) {
      const fullPathCmd = `rg -l -F "${targetFile}" -g "*.txt" .`;
      try {
        const results = execSync(fullPathCmd, {
          cwd: outDir,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "ignore"],
        })
          .split("\n")
          .filter(Boolean);
        results.forEach((f) => addScore(f, 120, `full path target_file match`));
      } catch (_) {}
    }
  } catch (err: any) {}

  try {
    const escapedSymbol = targetSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const symbolCountCmd = `rg -c "${escapedSymbol}" -g "*.txt" . | sort -t: -k2 -rn`;
    try {
      const lines = execSync(symbolCountCmd, {
        cwd: outDir,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      })
        .split("\n")
        .filter(Boolean);

      lines.forEach((line, idx) => {
        const parts = line.split(":");
        if (parts.length >= 2) {
          const file = parts.slice(0, -1).join(":");
          const count = parseInt(parts[parts.length - 1], 10) || 0;
          addScore(
            file,
            60 + count * 2 - idx,
            `symbol "${targetSymbol}" appears ${count}x`,
          );
        }
      });
    } catch (_) {}
  } catch (err: any) {}

  try {
    const keywordHits = new Map<string, number>();

    for (const kw of searchKeywords) {
      try {
        const kwCmd = `rg -l -F "${kw}" -g "*.txt" .`;
        const results = execSync(kwCmd, {
          cwd: outDir,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "ignore"],
        })
          .split("\n")
          .filter(Boolean);
        results.forEach((f) => {
          keywordHits.set(f, (keywordHits.get(f) || 0) + 1);
        });
      } catch (_) {}
    }

    keywordHits.forEach((hits, file) => {
      addScore(
        file,
        hits * 15,
        `${hits}/${searchKeywords.length} keywords matched`,
      );
    });
  } catch (err: any) {}

  scored.forEach((entry, file) => {
    const content = (() => {
      try {
        return fs.readFileSync(path.join(outDir, file), "utf8");
      } catch {
        return "";
      }
    })();
    const symbolRoot = targetSymbol.split(".")[0].split("(")[0].trim();
    if (symbolRoot && !content.includes(symbolRoot)) {
      entry.score = Math.max(0, entry.score - 30);
      entry.reason += `, symbol root "${symbolRoot}" not found (penalized)`;
    }
  });

  const sorted = Array.from(scored.values())
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);

  sorted.forEach((e, i) => {});

  return sorted.map((e) => path.join(outDir, e.filePath));
}

export function generateGapFillerNotebook(
  outDir: string,
  targetSymbol: string,
  targetFile?: string,
  searchKeywords: string[] = [],
): { gapSourceFiles: string[]; gapAnalysisBundle: string } {
  const allCandidateFiles = new Set<string>();
  const scores = new Map<string, number>();

  const cleanSymbol = targetSymbol.split(" ")[0].replace(/[()]/g, "");
  const symRoot = cleanSymbol.split(".")[0];
  const escapedSymbol = cleanSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedRoot = symRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const graphPath = path.join(outDir, "graph.json");
  const symbolsPath = path.join(outDir, "symbols.json");

  let importGraph: Record<string, { imports: string[]; imported_by: string[] }> =
    {};
  let symbolIndex: Record<string, { defined_in: string; used_in: string[] }> =
    {};

  try {
    if (fs.existsSync(graphPath)) {
      importGraph = JSON.parse(fs.readFileSync(graphPath, "utf-8"));
    }
    if (fs.existsSync(symbolsPath)) {
      symbolIndex = JSON.parse(fs.readFileSync(symbolsPath, "utf-8"));
    }
  } catch (_) {}

  const conductGlobalSearch = (pattern: string, weight: number) => {
    try {
      const matches = execSync(`rg -l "${pattern}" .`, {
        cwd: outDir,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      })
        .split("\n")
        .filter(Boolean);

      matches.forEach((f) => {
        allCandidateFiles.add(f);
        scores.set(f, (scores.get(f) || 0) + weight);
      });
    } catch (_) {}
  };

  // 1. Precise Structural Search
  const structuralTargets = new Set<string>();
  if (targetFile) structuralTargets.add(targetFile);

  // Symbol resolution
  if (symbolIndex[cleanSymbol]) {
    const definingFile = symbolIndex[cleanSymbol].defined_in;
    structuralTargets.add(definingFile);
    conductGlobalSearch(path.basename(definingFile), 1200); // Super high weight for definition
  }

  if (Object.keys(importGraph).length > 0) {
    for (const file of structuralTargets) {
      if (importGraph[file]) {
        // High weight for neighbors
        importGraph[file].imports.forEach((dep) => {
          conductGlobalSearch(path.basename(dep), 800);
        });
        importGraph[file].imported_by.forEach((consumer) => {
          conductGlobalSearch(path.basename(consumer), 800);
        });
      }
    }
  }

  // 2. Heuristic Search (standard)
  conductGlobalSearch(`\\b${escapedSymbol}\\b`, 1000);
  if (escapedRoot !== escapedSymbol) {
    conductGlobalSearch(`\\b${escapedRoot}\\b`, 500);
  }

  searchKeywords.forEach((kw) => {
    const escapedKw = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    conductGlobalSearch(escapedKw, 300);
  });
  if (targetFile) {
    const escapedPath = targetFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    conductGlobalSearch(escapedPath, 200);
  }

  if (allCandidateFiles.size === 0) {
    return { gapSourceFiles: [], gapAnalysisBundle: "" };
  }

  const sortedFiles = Array.from(allCandidateFiles)
    .sort((a, b) => (scores.get(b) || 0) - (scores.get(a) || 0))
    .slice(0, 15);

  let gapAnalysisBundle = `# GAP-FILLER COMPREHENSIVE HARVEST\n`;
  gapAnalysisBundle += `Target Symbol: ${targetSymbol}\nTarget File: ${targetFile}\nKeywords: ${searchKeywords.join(", ")}\n\n`;

  // 3. Structural Roadmap Header
  if (structuralTargets.size > 0) {
    gapAnalysisBundle += `## STRUCTURAL ROADMAP (from dependencies)\n\n`;
    for (const file of structuralTargets) {
      gapAnalysisBundle += `### Anchor: ${file}\n`;
      const info = importGraph[file];
      if (info) {
        if (info.imports.length > 0) {
          gapAnalysisBundle += `- **Dependencies (Imports):** ${info.imports.join(", ")}\n`;
        }
        if (info.imported_by.length > 0) {
          gapAnalysisBundle += `- **Consumers (Imported By):** ${info.imported_by.join(", ")}\n`;
        }
      }
      const defined = Object.entries(symbolIndex).find(([s, meta]) => meta.defined_in === file);
      if (defined) {
        gapAnalysisBundle += `- **Key Symbols Defined:** ${defined[0]} (and potentially others)\n`;
      }
      gapAnalysisBundle += `\n`;
    }
    gapAnalysisBundle += `---\n\n`;
  }

  const gapSourceFiles: string[] = [];
  for (const f of sortedFiles) {
    const absPath = path.isAbsolute(f) ? f : path.join(outDir, f);
    if (fs.existsSync(absPath)) {
      gapSourceFiles.push(absPath);
      const content = fs.readFileSync(absPath, "utf-8");
      const lines = content.split("\n");

      const snipRegex = new RegExp(
        [escapedSymbol, escapedRoot, ...searchKeywords].join("|"),
        "gi",
      );

      const ranges: { start: number; end: number }[] = [];
      lines.forEach((line, i) => {
        snipRegex.lastIndex = 0;
        if (snipRegex.test(line)) {
          ranges.push({
            start: Math.max(0, i - 100),
            end: Math.min(lines.length - 1, i + 100),
          });
        }
      });

      if (ranges.length > 0) {
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

        gapAnalysisBundle += `## SOURCE SHARD: ${f}\n\n`;
        for (const range of merged) {
          gapAnalysisBundle += `### Lines ${range.start + 1}-${range.end + 1}\n\n`;
          gapAnalysisBundle += "```typescript\n";
          gapAnalysisBundle += lines
            .slice(range.start, range.end + 1)
            .join("\n");
          gapAnalysisBundle += "\n```\n\n";
        }
        gapAnalysisBundle += "---\n\n";
      }
    }
  }

  return { gapSourceFiles, gapAnalysisBundle };
}
