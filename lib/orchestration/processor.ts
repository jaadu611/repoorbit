import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { analyzeFile } from "@/lib/core/github";
import { buildMasterContext } from "@/lib/builders/context";
import { buildDeepseekContext } from "@/lib/builders/deepseekContext";
import { getOrCreateContext } from "@/lib/core/browser";
import { automateChatGPT } from "@/lib/automation/chatgpt";
import { cloneRepoForDiskWork } from "@/lib/automation/opencode";
import { activeJobs, persistentPages } from "./globals";
import { runDualPlanner } from "./planning";
import { collectRelevantFiles, collectGenericAnswers } from "./evidence";
import { runCoderReviewerLoop } from "./surgery";
import { runSurgeryPhase2 } from "./surgeryPhase2";
import { writeOpencodeConfig } from "./utils";

export async function processJob(
  taskId: string,
  query: string,
  owner: string,
  repo: string,
  defaultBranch: string,
  outDir: string,
) {
  const manifestPath = path.join(outDir, "00_Root_Manifest.txt");

  try {
    const onStatus = (
      msg: string,
      partial?: string,
      overrideProgress?: number,
    ) => {
      const job = activeJobs.get(taskId);
      if (job)
        activeJobs.set(taskId, {
          ...job,
          statusText: msg,
          partialResult: partial,
          progress: overrideProgress,
        });
    };

    const questionsUsed = new Map<string, number>();
    ["coder_a", "coder_b", "reviewer_a", "reviewer_b", "gemma", "architect"].forEach(
      (r) => questionsUsed.set(r, 0),
    );

    // Step 1: Clone repo and build notebooks (only on first run)
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
      const tmpRepoDir = path.join(outDir, `tmp_clone_${Date.now()}`);
      onStatus("Cloning repository...", undefined, 5);
      try {
        execSync(
          `git clone --depth=1 https://github.com/${owner}/${repo}.git ${tmpRepoDir}`,
          { stdio: "pipe" },
        );
      } catch (cloneErr: any) {
        activeJobs.set(taskId, {
          status: "error",
          error: `git clone failed: ${cloneErr.message}`,
        });
        return;
      }

      onStatus("Gathering repository metadata...", undefined, 20);
      const ignoredExtensions = [
        ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".bmp", ".webp",
        ".mp4", ".mp3", ".wav", ".zip", ".tar", ".gz", ".pdf", ".ttf",
        ".woff", ".woff2", ".lock", ".log", ".DS_Store", ".eslintcache", ".sketch",
      ];
      const ignoredNames = [
        "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock",
        "Cargo.lock", "poetry.lock", "Gemfile.lock", ".gitignore", ".gitattributes",
      ];
      const filesMetadata: any[] = [];

      const walkRepo = (dir: string) => {
        let entries: string[];
        try { entries = fs.readdirSync(dir); } catch { return; }
        for (const entry of entries) {
          const fullPath = path.join(dir, entry);
          let stat: fs.Stats;
          try { stat = fs.statSync(fullPath); } catch { continue; }
          if (stat.isDirectory()) {
            if ([".git", "node_modules", "vendor"].includes(entry)) continue;
            walkRepo(fullPath);
            continue;
          }
          const relPath = path.relative(tmpRepoDir, fullPath);
          const pLower = relPath.toLowerCase();
          if (ignoredExtensions.some((ext) => pLower.endsWith(ext))) continue;
          if (ignoredNames.some((name) => pLower.endsWith(name))) continue;
          if (stat.size > 500000) continue;
          try {
            const content = fs.readFileSync(fullPath, "utf-8");
            filesMetadata.push({
              path: relPath, content, size: stat.size,
              name: entry, type: "file", ext: entry.split(".").pop() || "",
            });
          } catch { continue; }
        }
      };
      walkRepo(tmpRepoDir);

      onStatus("Building master context...", undefined, 30);
      const miniRepoContext = {
        meta: { fullName: `${owner}/${repo}`, owner, name: repo },
        stats: { extFrequency: {} },
      };
      const fileSet = new Set<string>(filesMetadata.map((f) => f.path));
      const importGraph: any = {};
      const totalFiles = filesMetadata.length;

      for (let i = 0; i < totalFiles; i++) {
        const f = filesMetadata[i];
        const analysis = analyzeFile(f.path, f.content, fileSet);
        importGraph[f.path] = { imports: analysis.imports, imported_by: [] };
        if (i % 100 === 0) await new Promise((r) => setImmediate(r));
        if (i % 500 === 0 || i === totalFiles - 1) {
          const p = Math.round((i / totalFiles) * 10);
          onStatus(`Analyzing repository structure (${i}/${totalFiles})...`, undefined, 20 + p);
        }
      }
      await buildMasterContext(
        outDir, filesMetadata, importGraph, miniRepoContext, query,
        undefined, true, {}, 2,
        (msg, p) => onStatus(msg, undefined, Math.round(30 + p * 0.7)),
      );
      fs.rmSync(tmpRepoDir, { recursive: true, force: true });
    }

    const context = await getOrCreateContext();
    if (!persistentPages.dsCoder || persistentPages.dsCoder.isClosed()) persistentPages.dsCoder = await context.newPage();
    if (!persistentPages.qwenCoder || persistentPages.qwenCoder.isClosed()) persistentPages.qwenCoder = await context.newPage();
    if (!persistentPages.dsReviewer || persistentPages.dsReviewer.isClosed()) persistentPages.dsReviewer = await context.newPage();
    if (!persistentPages.qwenReviewer || persistentPages.qwenReviewer.isClosed()) persistentPages.qwenReviewer = await context.newPage();
    if (!persistentPages.dsSynthesizer || persistentPages.dsSynthesizer.isClosed()) persistentPages.dsSynthesizer = await context.newPage();

    const repoUrl = `https://github.com/${owner}/${repo}`;
    const rootManifestContent = fs.readFileSync(manifestPath, "utf-8");
    const readmePath = path.join(outDir, "README.md");
    const notebooksPath = path.join(outDir, "notebooks.json");
    const plannerFiles = [manifestPath];
    if (fs.existsSync(readmePath)) plannerFiles.push(readmePath);
    if (fs.existsSync(notebooksPath)) plannerFiles.push(notebooksPath);

    const plan = await runDualPlanner(
      context, query, rootManifestContent, repoUrl, defaultBranch,
      plannerFiles, outDir, (msg) => onStatus(msg)
    );

    if (plan.status === "GENERIC") {
      const genericAnswers = await collectGenericAnswers(context, plan.notebooks || [], outDir, (msg) => onStatus(msg));
      const answersBlock = genericAnswers.length > 0
        ? genericAnswers.map((a, i) => `### Analysis ${i + 1} — ${a.notebook}\n**Sub-Question:** ${a.sub_question}\n\n${a.answer}`).join("\n\n---\n\n")
        : "(No notebook analysis available)";

      const chatGPTPrompt = `Synthesize these insights into a cohesive answer for: ${query}\n\n### ANALYSIS\n${answersBlock}`;
      const chatPage = context.pages().find((p) => p.url().includes("chatgpt.com")) || await context.newPage();
      const genericResult = await automateChatGPT(chatPage, chatGPTPrompt, (msg) => onStatus(`[ChatGPT] ${msg}`));
      activeJobs.set(taskId, { status: "done", result: genericResult, answerSource: "final" });
      return;
    }

    if (plan.status === "FAILED") {
      activeJobs.set(taskId, { status: "error", error: "Planner failed." });
      return;
    }

    onStatus("NotebookLM is gathering evidence...");
    const contextFiles = await collectRelevantFiles(context, query, plan.notebooks || [], outDir, onStatus);

    onStatus("Building precise code context...");
    const dsBaseContextDir = path.join(outDir, "deepseek_context");
    buildDeepseekContext({ intent: query, context_files: contextFiles, target_symbols: [] }, outDir);

    const finalAnswer = await runCoderReviewerLoop(
      query, owner, repo, defaultBranch, outDir, dsBaseContextDir,
      rootManifestContent, context, (msg) => onStatus(msg), questionsUsed
    );

    const repoWorkDir = await cloneRepoForDiskWork(owner, repo);
    writeOpencodeConfig(repoWorkDir);

    onStatus("Initializing OpenCode server (Port 3001)...");
    const { ensureOpenCodeServer } = await import("@/lib/automation/opencode");
    await ensureOpenCodeServer(3001, repoWorkDir);

    const flashResult = await runSurgeryPhase2(
      owner, repo, repoWorkDir, finalAnswer, outDir, (msg) => onStatus(msg), questionsUsed
    );

    activeJobs.set(taskId, { status: "done", result: flashResult, answerSource: "reviewed" });
  } catch (err: any) {
    console.error("[PROCESS-JOB] Error:", err);
    activeJobs.set(taskId, { status: "error", error: err.message });
  }
}
