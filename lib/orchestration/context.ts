import fs from "fs";
import path from "path";
import { fetchFile } from "./github";
import { MAX_LINES_PER_FILE, MAX_FILES_PER_TURN } from "./constants";
import { getFuzzyCandidates } from "./utils";

export async function fillMissingFiles(
  missingFiles: any[],
  modelName: string,
  modelInvestDir: string,
  owner: string,
  repo: string,
  branch: string,
  outDir: string,
  manifestContent?: string,
  _latestResponsePath?: string,
): Promise<number> {
  const filesToFetch = missingFiles.slice(0, MAX_FILES_PER_TURN);
  let count = 0;

  for (const f of filesToFetch) {
    const rawPath = f.path || f.file_path;
    if (!rawPath) continue;

    console.log(
      `[ORCHESTRATOR] Processing model request: ${JSON.stringify(f)}`,
    );

    let filePath = rawPath;

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

    let content = await fetchFile(
      outDir,
      owner,
      repo,
      branch,
      filePath,
      lineRange as [number, number],
    );

    // FUZZY RECOVERY
    if (content === null) {
      let fuzzyCandidates = getFuzzyCandidates(filePath);

      // Add candidates from manifest if available
      if (manifestContent) {
        const base = path.basename(filePath);
        const manifestPaths = manifestContent
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        const manifestMatches = manifestPaths.filter(
          (p) => p.endsWith(base) && p !== filePath,
        );
        fuzzyCandidates = [
          ...new Set([...fuzzyCandidates, ...manifestMatches]),
        ];
      }

      for (const candidate of fuzzyCandidates) {
        console.log(
          `[ORCHESTRATOR] ${modelName}: ${filePath} not found. Trying fuzzy recovery: ${candidate}`,
        );
        content = await fetchFile(
          outDir,
          owner,
          repo,
          branch,
          candidate,
          lineRange as [number, number],
        );
        if (content !== null) {
          console.log(
            `[ORCHESTRATOR] ${modelName}: Fuzzy recovery SUCCESS for ${candidate}`,
          );
          filePath = candidate; // Update filePath for logging/saving
          break;
        }
      }
    }

    if (content === null) {
      console.warn(
        `[ORCHESTRATOR] ${modelName}: Skipping ${filePath} (not found).`,
      );
      // User requested: "send along the files address that this file doesnt exist"
      content = `// [SYSTEM ERROR]: The file "${filePath}" could not be found in the repository manifest.\n// Please check the path and try again or use the manifest to find correct paths.`;
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
