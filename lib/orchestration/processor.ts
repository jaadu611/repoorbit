import fs from "fs";
import path from "path";
import { buildMasterContext } from "@/lib/builders/context";
import { activeJobs } from "./globals";
import { ensureOpenCodeServer, runAutonomousAgent } from "@/lib/automation/opencode";
import { runTestSuite, runTestFixLoop } from "./testRunner";
import {
  ensureDepsInstalled,
  getGitDiff,
  commitAndCreatePR,
  rollbackChanges,
  buildDiffSummaryMarkdown,
  appendChangelog,
} from "./gitOps";
import {
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  isStepComplete,
  CheckpointData,
} from "./checkpoint";
import { getTokenStats, formatTokenReport, clearJobStats } from "./tokenTracker";
import { setLLMContext } from "@/lib/automation/llm";
import { ChatStep, CombinedFile } from "@/lib/core/types";
import { cloneRepoForDiskWork } from "@/lib/automation/sandbox";

// Re-export setLLMContext from llm so it can be imported here
// (it's already imported above)

export async function processJob(
  taskId: string,
  query: string,
  owner: string,
  repo: string,
  defaultBranch: string,
  outDir: string,
) {
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
      onStatus(step.label);
    };

    const onStatus = (
      msg: string,
      partial?: string,
      overrideProgress?: number,
      _unused?: ChatStep[],
      files?: CombinedFile[],
      logs?: string,
      agents?: any[],
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
          agents: agents ?? job.agents,
        });
    };

    const updateAgent = (agent: {
      id: string; name: string; model: string; status: any; lastMsg?: string;
    }) => {
      const job = activeJobs.get(taskId);
      if (job) {
        const current = job.agents || [];
        const idx = current.findIndex((a) => a.id === agent.id);
        if (idx >= 0) current[idx] = { ...current[idx], ...agent };
        else current.push(agent);
        onStatus(job.statusText || "", undefined, undefined, undefined, undefined, undefined, [...current]);
      }
    };

    const questionsUsed = new Map<string, number>();
    ["post_reviewer", "surgeon", "test_fixer"].forEach(
      (r) => questionsUsed.set(r, 0),
    );

    // ── Load checkpoint (if any) ──────────────────────────────────
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    let ckpt: CheckpointData | null = loadCheckpoint(outDir, taskId, owner, repo, query);

    if (ckpt) {
      onStatus(`⏩ Resuming from checkpoint (last step: ${ckpt.completedSteps.at(-1) ?? "none"})...`);
    }

    // Accumulated step outputs (loaded from checkpoint or computed fresh)
    let repoWorkDir: string = ckpt?.repoWorkDir ?? "";
    let rootManifestContent: string = ckpt?.rootManifestContent ?? "";
    let baselinePassed: string[] = ckpt?.baselinePassed ?? [];
    let baselineFailed: string[] = ckpt?.baselineFailed ?? [];
    let finalAnswer: string = ckpt?.finalAnswer ?? "";
    let testSummary: string = ckpt?.testSummary ?? "";
    let diffMarkdown: string = ckpt?.diffMarkdown ?? "";

    // ─────────────────────────────────────────────────────────────
    // STEP 1 — CLONE + INDEX
    // ─────────────────────────────────────────────────────────────
    if (!isStepComplete(ckpt, "sync")) {
      addOrUpdateStep("sync", "Environment", "running");
      onStatus("Initializing sandbox...", undefined, 3);
      repoWorkDir = await cloneRepoForDiskWork(owner, repo, taskId);

      onStatus("Indexing repository...", undefined, 8);
      const filesMetadata: any[] = [];
      const walkRepo = (dir: string) => {
        for (const entry of fs.readdirSync(dir)) {
          if (entry === ".git" || entry === "node_modules") continue;
          const full = path.join(dir, entry);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) { walkRepo(full); continue; }
          filesMetadata.push({
            path: path.relative(repoWorkDir, full),
            size: stat.size, name: entry, type: "file",
            ext: entry.split(".").pop() || "",
          });
        }
      };
      walkRepo(repoWorkDir);

      await buildMasterContext(outDir, filesMetadata, {},
        { meta: { fullName: `${owner}/${repo}`, owner, name: repo }, stats: { extFrequency: {} } },
        query, undefined, true, {}, 2,
        (msg, p) => onStatus(msg, undefined, Math.round(10 + p * 0.4)),
      );
      rootManifestContent = fs.readFileSync(path.join(outDir, "00_Root_Manifest.txt"), "utf-8");
      addOrUpdateStep("sync", "Environment", "done", "Sandbox ready.");

      ckpt = saveCheckpoint(outDir, {
        taskId, owner, repo, query,
        completedSteps: [...(ckpt?.completedSteps ?? []), "sync"],
        repoWorkDir, rootManifestContent,
      });
    } else {
      addOrUpdateStep("sync", "Environment", "done", "✓ Restored from checkpoint.");
    }

    // ─────────────────────────────────────────────────────────────
    // STEP 2 — PRE-FLIGHT BASELINE
    // ─────────────────────────────────────────────────────────────
    if (!isStepComplete(ckpt, "preflight")) {
      addOrUpdateStep("preflight", "Pre-flight Baseline", "running");
      onStatus("Pre-flight — Installing dependencies...", undefined, 18);
      await ensureDepsInstalled(repoWorkDir, (msg) => onStatus(msg));

      setLLMContext(taskId, "other");
      onStatus("Pre-flight — Running baseline tests on unmodified repo...", undefined, 20);
      const baseline = await runTestSuite(repoWorkDir, (msg) => onStatus(msg));
      fs.writeFileSync(path.join(outDir, "baseline_test_result.json"), JSON.stringify(baseline, null, 2));

      baselinePassed = baseline.results.filter((r) => r.passed).map((r) => r.name);
      baselineFailed = baseline.results.filter((r) => !r.passed).map((r) => r.name);
      addOrUpdateStep("preflight", "Pre-flight Baseline", "done",
        `${baselinePassed.length} passing, ${baselineFailed.length} pre-existing failures.\n${baseline.summary}`);

      ckpt = saveCheckpoint(outDir, {
        taskId, owner, repo, query,
        completedSteps: [...(ckpt?.completedSteps ?? []), "preflight"],
        repoWorkDir, rootManifestContent, baselinePassed, baselineFailed,
      });
    } else {
      addOrUpdateStep("preflight", "Pre-flight Baseline", "done", "✓ Restored from checkpoint.");
    }

    // ─────────────────────────────────────────────────────────────
    // STEP 3 — SURGERY + REVIEW LOOP
    // OpenCode receives the raw task, investigates the repo itself,
    // applies all changes, then Reviewer verifies via git diff.
    // ─────────────────────────────────────────────────────────────
    if (!isStepComplete(ckpt, "execution")) {
      addOrUpdateStep("execution", "Autonomous Surgery", "running");
      onStatus("Agent is investigating and fixing the repo...", undefined, 38);
      
      const agentPrompt = `
### TASK
${query}

### INSTRUCTIONS
1. Explore the repository to understand the code.
2. Apply all necessary fixes using your tools (edit/write/bash).
3. Verify your changes are correct.
4. When finished, provide a summary of your work.
`;

      await ensureOpenCodeServer(3001, repoWorkDir);
      const result = await runAutonomousAgent(3001, repoWorkDir, agentPrompt);
      
      addOrUpdateStep("execution", "Autonomous Surgery", "done", result);

      ckpt = saveCheckpoint(outDir, {
        taskId, owner, repo, query,
        completedSteps: [...(ckpt?.completedSteps ?? []), "execution"],
        repoWorkDir, rootManifestContent, baselinePassed, baselineFailed,
      });
    } else {
      addOrUpdateStep("execution", "Surgery + Review Loop", "done", "✓ Restored from checkpoint.");
    }

    // ─────────────────────────────────────────────────────────────
    // STEP 5 — TEST SUITE
    // ─────────────────────────────────────────────────────────────
    if (!isStepComplete(ckpt, "testing")) {
      addOrUpdateStep("testing", "Test Suite", "running");
      onStatus("Running full test suite...", undefined, 62);
      setLLMContext(taskId, "test_diag");

      let testResult = await runTestSuite(repoWorkDir, (msg) => onStatus(msg));
      fs.writeFileSync(path.join(outDir, "test_result_initial.json"), JSON.stringify(testResult, null, 2));

      const regressions = testResult.results.filter(
        (r) => !r.passed && baselinePassed.includes(r.name),
      );

      if (regressions.length > 0 || !testResult.allPassed) {
        const failCount = testResult.results.filter((r) => !r.passed).length;
        onStatus(`Tests: ${failCount} failure(s). Starting auto-fix loop...`, undefined, 70);
        testResult = await runTestFixLoop(repoWorkDir, testResult, outDir, (msg) => onStatus(msg), updateAgent, 3);
      }

      testSummary = testResult.allPassed
        ? `✓ All checks passed\n${testResult.summary}`
        : `⚠️ ${testResult.results.filter((r) => !r.passed).length} check(s) still failing:\n${testResult.summary}\n\nAI Diagnosis:\n${testResult.aiDiagnosis || "N/A"}`;

      addOrUpdateStep("testing", "Test Suite", testResult.allPassed ? "done" : "error", testSummary);

      ckpt = saveCheckpoint(outDir, {
        taskId, owner, repo, query,
        completedSteps: [...(ckpt?.completedSteps ?? []), "testing"],
        repoWorkDir, rootManifestContent, baselinePassed, baselineFailed, finalAnswer, testSummary,
      }) as any;
    } else {
      addOrUpdateStep("testing", "Test Suite", "done", "✓ Restored from checkpoint.");
    }

    // ─────────────────────────────────────────────────────────────
    // STEP 6 — DIFF SUMMARY
    // ─────────────────────────────────────────────────────────────
    if (!isStepComplete(ckpt, "diff")) {
      addOrUpdateStep("diff", "Diff Summary", "running");
      onStatus("Generating diff summary...", undefined, 82);
      const finalDiff = await getGitDiff(repoWorkDir);
      diffMarkdown = buildDiffSummaryMarkdown(finalDiff);
      fs.writeFileSync(path.join(outDir, "diff_summary.md"), diffMarkdown);
      addOrUpdateStep("diff", "Diff Summary", "done",
        `${finalDiff.filesChanged.length} files | +${finalDiff.additions} / -${finalDiff.deletions} lines`);

      ckpt = saveCheckpoint(outDir, {
        taskId, owner, repo, query,
        completedSteps: [...(ckpt?.completedSteps ?? []), "diff"],
        repoWorkDir, rootManifestContent, baselinePassed, baselineFailed,
        finalAnswer, testSummary, diffMarkdown,
      }) as any;
    } else {
      addOrUpdateStep("diff", "Diff Summary", "done", "✓ Restored from checkpoint.");
    }

    // ─────────────────────────────────────────────────────────────
    // STEP 7 — TOKEN REPORT
    // ─────────────────────────────────────────────────────────────
    const tokenStats = getTokenStats(taskId);
    const tokenReport = formatTokenReport(tokenStats);
    fs.writeFileSync(path.join(outDir, "token_report.md"), tokenReport);
    addOrUpdateStep("tokens", "Token Report", "done",
      `${tokenStats.calls} API calls | ~${tokenStats.totalTokens.toLocaleString()} tokens | ~$${tokenStats.estimatedCostUSD.toFixed(4)}`);

    // ─────────────────────────────────────────────────────────────
    // STEP 8 — COMMIT + CHANGELOG + PR  (or rollback)
    // ─────────────────────────────────────────────────────────────
    if (!isStepComplete(ckpt, "delivery")) {
      addOrUpdateStep("delivery", "Commit + PR", "running");

      const finalDiff = await getGitDiff(repoWorkDir);

      // Rollback if regressions remain
      const remainingRegressions = (await runTestSuite(repoWorkDir, () => {})).results.filter(
        (r) => !r.passed && baselinePassed.includes(r.name),
      );

      if (remainingRegressions.length > 0) {
        onStatus(`⚠️ ${remainingRegressions.length} regression(s) remain. Rolling back...`);
        await rollbackChanges(repoWorkDir, (msg) => onStatus(msg));
        addOrUpdateStep("delivery", "Commit + PR", "error",
          `Rolled back — regressions in: ${remainingRegressions.map((r) => r.name).join(", ")}`);
      } else if (finalDiff.filesChanged.length === 0) {
        addOrUpdateStep("delivery", "Commit + PR", "error", "No files changed — nothing to commit.");
      } else {
        onStatus("Committing and creating PR...", undefined, 90);
        const gitResult = await commitAndCreatePR(
          owner, repo, repoWorkDir, query, finalDiff, (msg) => onStatus(msg),
        );

        // Update CHANGELOG
        await appendChangelog(repoWorkDir, query, finalDiff, gitResult.prUrl, (msg) => onStatus(msg));

        // Force-push again after changelog amend
        if (gitResult.prUrl) {
          const token = process.env.GITHUB_TOKEN || process.env.NEXT_PUBLIC_GITHUB_TOKEN;
          if (token) {
            try {
              const { exec: execSync } = await import("child_process");
              const { promisify } = await import("util");
              const execP = promisify(execSync);
              await execP(`git push origin ${gitResult.branchName} --force`, { cwd: repoWorkDir });
            } catch { /* non-fatal */ }
          }
        }

        addOrUpdateStep("delivery", "Commit + PR",
          gitResult.prUrl ? "done" : "error",
          gitResult.prUrl
            ? `PR: ${gitResult.prUrl}\nBranch: ${gitResult.branchName}\nCommit: ${gitResult.commitSha.slice(0, 8)}`
            : `Committed locally (${gitResult.commitSha.slice(0, 8)}) — no GITHUB_TOKEN for PR.`,
        );
      }

      saveCheckpoint(outDir, {
        taskId, owner, repo, query,
        completedSteps: [...(ckpt?.completedSteps ?? []), "delivery"],
        repoWorkDir, rootManifestContent, baselinePassed, baselineFailed,
        finalAnswer, testSummary, diffMarkdown,
      });
    } else {
      addOrUpdateStep("delivery", "Commit + PR", "done", "✓ Restored from checkpoint.");
    }

    // ─────────────────────────────────────────────────────────────
    // DONE — Persist final result and clean up
    // ─────────────────────────────────────────────────────────────
    clearCheckpoint(outDir);
    clearJobStats(taskId);

    const finalResult = [
      diffMarkdown,
      "",
      "---",
      "## Test Results",
      testSummary,
      "",
      "---",
      tokenReport,
    ].join("\n");

    activeJobs.set(taskId, {
      status: "done",
      result: finalResult,
      answerSource: "solo",
      history: [...history],
    });

    onStatus("✓ All done.", undefined, 100);
  } catch (err: any) {
    console.error("[PROCESS-JOB] Fatal error:", err);
    // Don't clear checkpoint on error — allow resume
    activeJobs.set(taskId, { status: "error", error: err.message });
  }
}
