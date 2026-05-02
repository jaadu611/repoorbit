import fs from "fs";
import path from "path";
import { buildDeepseekContext } from "@/lib/builders/deepseekContext";
import { fetchFile } from "./github";
import { MAX_LINES_PER_FILE, MAX_FILES_PER_TURN } from "./constants";

export async function fillMissingFiles(
  missingFiles: any[],
  filledSet: Set<string>,
  modelName: string,
  modelInvestDir: string,
  owner: string,
  repo: string,
  branch: string,
  outDir: string,
  _latestResponsePath?: string,
): Promise<number> {
  const filesToFetch = missingFiles.slice(0, MAX_FILES_PER_TURN);
  let count = 0;

  for (const f of filesToFetch) {
    const filePath = f.path || f.file_path;
    if (!filePath) continue;

    const lowerPath = filePath.toLowerCase();

    // Special handling for internal files requested by models
    if (lowerPath.includes("combined_response")) {
      const files = fs
        .readdirSync(outDir)
        .filter(
          (f) => f.startsWith("combined_response_") && !f.includes("debug"),
        );
      if (files.length > 0) {
        files.sort();
        const latest = files[files.length - 1];
        console.log(
          `[ORCHESTRATOR] ${modelName} requested ${filePath}. Fulfilling with latest: ${latest}`,
        );
        fs.copyFileSync(
          path.join(outDir, latest),
          path.join(modelInvestDir, latest),
        );
        count++;
        continue;
      }
    }

    if (lowerPath.includes("combined_review")) {
      const files = fs
        .readdirSync(outDir)
        .filter(
          (f) => f.startsWith("combined_review_") && !f.includes("debug"),
        );
      if (files.length > 0) {
        files.sort();
        const latest = files[files.length - 1];
        console.log(
          `[ORCHESTRATOR] ${modelName} requested ${filePath}. Fulfilling with latest: ${latest}`,
        );
        fs.copyFileSync(
          path.join(outDir, latest),
          path.join(modelInvestDir, latest),
        );
        count++;
        continue;
      }
    }

    if (
      lowerPath.includes("combined_") ||
      lowerPath.includes("review_") ||
      lowerPath.includes("symbols.") ||
      lowerPath.includes("manifest") ||
      lowerPath.includes("context.js") ||
      lowerPath.includes("meta.txt")
    ) {
      console.warn(
        `[ORCHESTRATOR] Blocking internal file request: ${filePath}`,
      );
      continue;
    }

    const lineRange = Array.isArray(f.line_range) ? f.line_range : undefined;
    const key = `${filePath}|${lineRange?.join(",") || ""}`.toLowerCase();
    if (filledSet.has(key)) continue;
    filledSet.add(key);

    console.log(
      `[ORCHESTRATOR] ${modelName} requesting: ${filePath}${lineRange ? ` lines ${lineRange.join("-")}` : ""}`,
    );

    // LOCAL FULFILLMENT
    const localPaths = [
      path.join(outDir, filePath),
      path.join(modelInvestDir, filePath),
      path.join(path.dirname(outDir), filePath),
    ];
    let localContent: string | null = null;
    for (const p of localPaths) {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        localContent = fs.readFileSync(p, "utf-8");
        break;
      }
    }

    if (localContent) {
      let slicedContent = localContent;
      const lines = localContent.split("\n");

      if (lineRange) {
        const startIdx = lineRange[0] > 0 ? lineRange[0] - 1 : 0;
        const endIdx =
          lineRange[1] > 0
            ? Math.min(lines.length - 1, lineRange[1] - 1)
            : lines.length - 1;
        const slice = lines.slice(startIdx, endIdx + 1);
        const MAX_RANGE_LIMIT = 2000;
        if (slice.length > MAX_RANGE_LIMIT) {
          slicedContent =
            slice.slice(0, MAX_RANGE_LIMIT).join("\n") +
            `\n\n// [TRUNCATED] Only first ${MAX_RANGE_LIMIT} lines of the requested range are shown.`;
        } else {
          slicedContent = slice.join("\n");
        }
      } else if (lines.length > MAX_LINES_PER_FILE) {
        slicedContent =
          lines.slice(0, MAX_LINES_PER_FILE).join("\n") +
          `\n\n// [TRUNCATED] Only first ${MAX_LINES_PER_FILE} lines shown. Use "line_range": [start, end] to request more.`;
      }

      const safeName = filePath.replace(/[^a-zA-Z0-9_-]/g, "_");
      const extraFileName = `extra_${count.toString().padStart(2, "0")}_${safeName}.txt`;
      fs.writeFileSync(
        path.join(modelInvestDir, extraFileName),
        slicedContent,
        "utf-8",
      );
      console.log(
        `[ORCHESTRATOR] ${modelName}: Local fulfillment for ${filePath} (${lineRange ? "ranged" : "full"})`,
      );
      count++;
      continue;
    }

    // SYMBOL REQUEST
    if (f.name_hint || f.name) {
      const symbolPathB = {
        intent: `Missing symbol: ${f.name_hint || f.name}`,
        target_symbols: [
          {
            name: f.name_hint || f.name,
            source_file: filePath,
            role: f.role,
            type: f.type,
          },
        ],
      };
      const tempOutDir = path.join(modelInvestDir, `temp_${count}`);
      fs.mkdirSync(tempOutDir, { recursive: true });
      ["notebooks.json", "package.json"].forEach((file) => {
        const src = path.join(outDir, file);
        if (fs.existsSync(src))
          fs.copyFileSync(src, path.join(tempOutDir, file));
      });

      buildDeepseekContext(symbolPathB, tempOutDir);

      const nestedDir = path.join(tempOutDir, "deepseek_context");
      if (fs.existsSync(nestedDir)) {
        for (const file of fs.readdirSync(nestedDir)) {
          const src = path.join(nestedDir, file);
          const dst = path.join(modelInvestDir, `extra_${count}_${file}`);
          fs.copyFileSync(src, dst);
        }
      }
      fs.rmSync(tempOutDir, { recursive: true, force: true });
      count++;
      continue;
    }

    const content = await fetchFile(
      outDir,
      owner,
      repo,
      branch,
      filePath,
      lineRange as [number, number],
    );
    if (content === null) {
      console.warn(
        `[ORCHESTRATOR] ${modelName}: Skipping ${filePath} (not found).`,
      );
      continue;
    }

    const safeName = filePath.replace(/[^a-zA-Z0-9_-]/g, "_");
    const extraFileName = `extra_${count.toString().padStart(2, "0")}_${safeName}.txt`;
    const extraFilePath = path.join(modelInvestDir, extraFileName);
    fs.mkdirSync(modelInvestDir, { recursive: true });
    fs.writeFileSync(extraFilePath, content, "utf-8");
    console.log(
      `[ORCHESTRATOR] ${modelName}: Saved extra context → ${extraFileName}`,
    );
    count++;
  }

  console.log(
    `[ORCHESTRATOR] ${modelName}: Extra files fetched this turn: ${count}`,
  );
  return count;
}
