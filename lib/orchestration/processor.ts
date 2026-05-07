import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { buildMasterContext } from "@/lib/builders/context";
import { getOrCreateContext } from "@/lib/core/browser";
import {
  cloneRepoForDiskWork,
  writeOpencodeConfig,
} from "@/lib/automation/opencode";
import { activeJobs, persistentPages } from "./globals";
import { runInitialSynthesis } from "./surgery";
import { runSurgeryPhase2 } from "./surgeryPhase2";
import { ChatStep, CombinedFile } from "@/lib/core/types";

const tmpRepoDir = path.join("/tmp", `repoorbit_${Date.now()}`);

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
    const history: ChatStep[] = [];

    const addOrUpdateStep = (
      id: string,
      label: string,
      status: ChatStep["status"],
      output?: string,
    ) => {
      let step = history.find((s) => s.id === id);
      if (!step) {
        step = { id, label, status };
        history.push(step);
      } else {
        step.status = status;
        if (label) step.label = label;
        if (output) step.output = output;
      }
      onStatus(step.label); // Trigger a refresh
    };

    const onStatus = (
      msg: string,
      partial?: string,
      overrideProgress?: number,
      _unused_history?: ChatStep[],
      files?: CombinedFile[],
      logs?: string,
    ) => {
      const job = activeJobs.get(taskId);
      if (job)
        activeJobs.set(taskId, {
          ...job,
          statusText: msg,
          partialResult: partial,
          progress: overrideProgress,
          history: [...history],
          files: files ?? job.files,
          logs: logs ?? job.logs,
        });
    };

    const questionsUsed = new Map<string, number>();
    [
      "coder_a",
      "coder_b",
      "reviewer_a",
      "reviewer_b",
      "gemma",
      "architect",
    ].forEach((r) => questionsUsed.set(r, 0));

    // Step 1: Clone repo and build notebooks (only on first run)
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
      addOrUpdateStep("sync", "Environment", "running");
      onStatus("Synchronizing repository environment...", undefined, 5);
      try {
        execSync(
          `git clone --depth=1 https://github.com/${owner}/${repo}.git ${tmpRepoDir}`,
          { stdio: "pipe" },
        );
      } catch (cloneErr: any) {
        addOrUpdateStep("sync", "Context Creation", "error", cloneErr.message);
        activeJobs.set(taskId, {
          status: "error",
          error: `git clone failed: ${cloneErr.message}`,
          history: [...history],
        });
        return;
      }

      onStatus("Gathering repository metadata...", undefined, 20);
      const filesMetadata: any[] = [];

      const walkRepo = (dir: string) => {
        let entries: string[];
        try {
          entries = fs.readdirSync(dir);
        } catch {
          return;
        }
        for (const entry of entries) {
          const fullPath = path.join(dir, entry);
          let stat: fs.Stats;
          try {
            stat = fs.statSync(fullPath);
          } catch {
            continue;
          }
          if (stat.isDirectory()) {
            walkRepo(fullPath);
            continue;
          }
          const relPath = path.relative(tmpRepoDir, fullPath);

          filesMetadata.push({
            path: relPath,
            size: stat.size,
            name: entry,
            type: "file",
            ext: entry.split(".").pop() || "",
          });
        }
      };
      walkRepo(tmpRepoDir);

      onStatus("Building master context...", undefined, 30);
      const miniRepoContext = {
        meta: { fullName: `${owner}/${repo}`, owner, name: repo },
        stats: { extFrequency: {} },
      };

      await buildMasterContext(
        outDir,
        filesMetadata,
        {}, // importGraph no longer needed for manifest
        miniRepoContext,
        query,
        undefined,
        true,
        {},
        2,
        (msg, p) => onStatus(msg, undefined, Math.round(30 + p * 0.7)),
      );
      addOrUpdateStep(
        "sync",
        "Environment",
        "done",
        `Repository indexed successfully. ${filesMetadata.length} files analyzed.`,
      );
      fs.rmSync(tmpRepoDir, { recursive: true, force: true });
    }

    const context = await getOrCreateContext();
    if (!persistentPages.qwenCoder || persistentPages.qwenCoder.isClosed())
      persistentPages.qwenCoder = await context.newPage();
    if (
      !persistentPages.qwenReviewer ||
      persistentPages.qwenReviewer.isClosed()
    )
      persistentPages.qwenReviewer = await context.newPage();
    if (
      !persistentPages.qwenSynthesizer ||
      persistentPages.qwenSynthesizer.isClosed()
    )
      persistentPages.qwenSynthesizer = await context.newPage();

    const repoUrl = `https://github.com/${owner}/${repo}`;
    const rootManifestContent = fs.readFileSync(manifestPath, "utf-8");
    const dsBaseContextDir = path.join(outDir, "deepseek_context");
    if (!fs.existsSync(dsBaseContextDir))
      fs.mkdirSync(dsBaseContextDir, { recursive: true });

    // --- PHASE 1: DIRECT IMPLEMENTATION (Coders decide context) ---
    addOrUpdateStep("synthesis", "Synthesizer", "running");

    const finalAnswer = await runInitialSynthesis(
      query,
      owner,
      repo,
      defaultBranch,
      outDir,
      dsBaseContextDir, // Initially empty or just manifest
      rootManifestContent,
      context,
      (msg) => onStatus(msg),
      questionsUsed,
    );
    addOrUpdateStep(
      "synthesis",
      "Synthesizer",
      "done",
      "Draft implementation and synthesis complete.",
    );

    addOrUpdateStep("execution", "Operator", "running");

    const repoWorkDir = await cloneRepoForDiskWork(owner, repo);
    writeOpencodeConfig(repoWorkDir);

    onStatus("Initializing OpenCode server (Port 3001)...");
    const { ensureOpenCodeServer } = await import("@/lib/automation/opencode");
    await ensureOpenCodeServer(3001, repoWorkDir);

    const flashResult = await runSurgeryPhase2(
      owner,
      repo,
      repoWorkDir,
      finalAnswer,
      outDir,
      (msg) => onStatus(msg),
      questionsUsed,
    );
    addOrUpdateStep(
      "execution",
      "Operator",
      "done",
      "Changes applied to the repository workspace.",
    );

    activeJobs.set(taskId, {
      status: "done",
      result: flashResult,
      answerSource: "reviewed",
      history: [...history],
    });
  } catch (err: any) {
    console.error("[PROCESS-JOB] Error:", err);
    activeJobs.set(taskId, { status: "error", error: err.message });
  }
}
