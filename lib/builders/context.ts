import fs, { mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";
import { RepoLanguage, ExpertPlan } from "@/lib/core/types";

function detectRepoLanguage(filesMetadata: any[]): RepoLanguage {
  if (!filesMetadata || filesMetadata.length === 0) return "mixed";
  const extCounts: Record<string, number> = {};
  for (const f of filesMetadata) {
    const p = (f.path as string).toLowerCase();
    if (p.includes("node_modules/")) continue;
    const ext = p.split(".").pop() ?? "";
    extCounts[ext] = (extCounts[ext] ?? 0) + 1;
  }
  let top: RepoLanguage = "mixed";
  let max = 0;
  for (const [ext, count] of Object.entries(extCounts)) {
    if (count > max) {
      max = count;
      if (["ts", "tsx"].includes(ext)) top = "typescript";
      else if (["js", "jsx"].includes(ext)) top = "javascript";
      else if (ext === "py") top = "python";
      else if (ext === "go") top = "go";
      else if (ext === "rs") top = "rust";
      else if (ext === "c") top = "c";
      else if (ext === "cpp") top = "cpp";
    }
  }
  return top;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

// --- Main export ---
export async function buildMasterContext(
  outputDir: string,
  filesMetadata: any[],
  importGraph: Record<string, any>,
  repoContext: any,
  query?: string,
  expertPlan?: ExpertPlan,
  dumpAll = true,
  aliases: Record<string, string> = {},
  kHopDepth: number = 2,
  onProgress?: (msg: string, progress: number) => void,
): Promise<{ content: string; lang: RepoLanguage }> {
  ensureDir(outputDir);
  const lang = detectRepoLanguage(filesMetadata);
  const repoName = repoContext?.meta?.fullName || "repo";

  const manifestLines = [
    `# Codebase Manifest: ${repoName}`,
    `Generated: ${new Date().toISOString()}`,
    `Primary Language: ${lang}`,
    "",
    "## File Inventory",
  ];

  const sortedFiles = filesMetadata
    .filter((f) => f && f.path)
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const f of sortedFiles) {
    manifestLines.push(`- ${f.path}`);
  }

  manifestLines.push("", "END OF MANIFEST");

  const manifestPath = join(outputDir, "00_Root_Manifest.txt");
  const content = manifestLines.join("\n");
  await writeFile(manifestPath, content, "utf-8");

  // Write a simple meta file too for planners
  const metaPath = join(outputDir, "01_Meta.txt");
  const metaContent = `Repo: ${repoName}\nDescription: ${repoContext?.meta?.description || "No description"}\nStars: ${repoContext?.meta?.stars || 0}\n`;
  await writeFile(metaPath, metaContent, "utf-8");

  return { content, lang };
}
