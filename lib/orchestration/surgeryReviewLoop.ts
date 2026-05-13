import path from "path";
import fs from "fs";
import {
  ensureOpenCodeServer,
  createSession,
  sendToOpenCode,
  getOpenCodeLogs,
  writeOpencodeConfig,
  OPENCODE_MODEL_ID,
} from "@/lib/automation/opencode";
import { getSurgeonPrompt, getReviewerPrompt } from "@/lib/prompts";
import { parseJsonFromText } from "./utils";
import { getGitDiff } from "./gitOps";

const OPENCODE_PORT = 3001;
const MAX_SURGERY_LOOPS = 4;

/**
 * Holds the two persistent OpenCode sessions used throughout the entire loop.
 * - coderSessionId  → OpenCode as the engineer applying changes
 * - reviewerSessionId → OpenCode as the reviewer exploring affected files
 *
 * Both sessions live on the same server but have completely separate
 * conversation histories. Neither session is ever recreated — context
 * accumulates across all passes.
 */
interface LoopSessions {
  coderSessionId: string;
  reviewerSessionId: string;
}

/**
 * Boots the OpenCode server once and creates TWO persistent sessions:
 * one for the coder and one for the reviewer.
 */
async function initLoopSessions(
  repoWorkDir: string,
  onStatus: (msg: string) => void,
): Promise<LoopSessions> {
  onStatus(`Operator — Booting OpenCode on port ${OPENCODE_PORT}...`);
  await ensureOpenCodeServer(OPENCODE_PORT, repoWorkDir);

  onStatus("Operator — Creating coder session...");
  const coderSessionId = await createSession(OPENCODE_PORT, repoWorkDir);
  console.log(`[SURGERY] Coder session: ${coderSessionId}`);

  onStatus("Operator — Creating reviewer session...");
  const reviewerSessionId = await createSession(OPENCODE_PORT, repoWorkDir);
  console.log(`[SURGERY] Reviewer session: ${reviewerSessionId}`);

  return { coderSessionId, reviewerSessionId };
}

/**
 * Sends one surgery pass to the PERSISTENT coder session.
 * Session retains full conversation history + file context from previous passes.
 */
async function runOneSurgeryPass(
  coderSessionId: string,
  operatorPrompt: string,
  onStatus: (msg: string) => void,
  updateAgent: (agent: any) => void,
  passNumber: number,
): Promise<string> {
  const logInterval = setInterval(() => {
    const logs = getOpenCodeLogs();
    if (logs) {
      const lastLine = logs.trim().split("\n").at(-1) || "";
      onStatus(
        lastLine.length > 0 && lastLine.length < 140
          ? `Coder — ${lastLine}`
          : "Coder — Working...",
      );
    }
  }, 1500);

  updateAgent({
    id: "surgeon",
    name: "OpenCode Coder",
    model: OPENCODE_MODEL_ID,
    status: "thinking",
    lastMsg: `Pass ${passNumber}: Applying changes...`,
  });

  let result = "";
  try {
    onStatus(`Coder — Applying changes (pass ${passNumber})...`);
    result = await sendToOpenCode(OPENCODE_PORT, coderSessionId, operatorPrompt);
  } finally {
    clearInterval(logInterval);
  }

  console.log(`[SURGERY] Coder pass ${passNumber} result:\n`, result);
  updateAgent({
    id: "surgeon",
    name: "OpenCode Coder",
    model: OPENCODE_MODEL_ID,
    status: "done",
    lastMsg: `Pass ${passNumber} complete.`,
  });

  return result || "Coder pass completed.";
}

/**
 * Runs the reviewer against the current git diff using the PERSISTENT reviewer session.
 *
 * The reviewer uses OpenCode's native file tools to:
 * 1. Read the diff
 * 2. Grep for callers/importers of changed files (blast radius)
 * 3. Read those affected files
 * 4. Output a JSON verdict
 *
 * Because the session is persistent, the reviewer remembers files it already
 * explored in earlier passes — it won't re-read them unless they changed.
 */
async function runPostSurgeryReview(
  reviewerSessionId: string,
  query: string,
  repoWorkDir: string,
  loopIndex: number,
  previousFeedback: string,
  onStatus: (msg: string) => void,
  updateAgent: (agent: any) => void,
): Promise<{ approved: boolean; feedback: string; suggestions: string; filesChanged: string[] }> {
  onStatus(`Reviewer — Capturing git diff for pass #${loopIndex + 1}...`);

  const diff = await getGitDiff(repoWorkDir);

  onStatus(
    `Reviewer — Investigating pass #${loopIndex + 1} (${diff.filesChanged.length} files changed + blast radius check)...`,
  );

  updateAgent({
    id: "post_reviewer",
    name: "OpenCode Reviewer",
    model: OPENCODE_MODEL_ID,
    status: "thinking",
    lastMsg: `Pass ${loopIndex + 1}: Reviewing ${diff.filesChanged.length} changed files + callers...`,
  });

  // Stream live logs to UI while reviewer works
  const logInterval = setInterval(() => {
    const logs = getOpenCodeLogs();
    if (logs) {
      const lastLine = logs.trim().split("\n").at(-1) || "";
      onStatus(
        lastLine.length > 0 && lastLine.length < 140
          ? `Reviewer — ${lastLine}`
          : "Reviewer — Investigating...",
      );
    }
  }, 1500);

  const reviewPrompt = getReviewerPrompt({
    userQuery: query,
    gitDiff: diff.filesChanged.length > 0 ? diff.raw : "⚠️ No changes detected on disk.",
    passNumber: loopIndex + 1,
    previousFeedback: loopIndex > 0 ? previousFeedback : undefined,
  });

  let reviewResponse = "";
  try {
    reviewResponse = await sendToOpenCode(
      OPENCODE_PORT,
      reviewerSessionId,
      reviewPrompt,
    );
  } finally {
    clearInterval(logInterval);
  }

  console.log(`[SURGERY] Reviewer pass ${loopIndex + 1} response:\n`, reviewResponse);

  const parsed = parseJsonFromText(reviewResponse) || {
    has_issues: diff.filesChanged.length === 0,
    feedback:
      diff.filesChanged.length === 0
        ? "No files were changed by this surgery pass."
        : "Could not parse review response.",
    suggestions: "",
  };

  const approved =
    diff.filesChanged.length > 0 &&
    (!parsed.has_issues ||
      parsed.feedback?.toUpperCase().includes("PERFECT") ||
      parsed.feedback?.toUpperCase().includes("ALL GOOD") ||
      parsed.feedback?.toUpperCase().includes("NO ISSUES"));

  updateAgent({
    id: "post_reviewer",
    name: "OpenCode Reviewer",
    model: OPENCODE_MODEL_ID,
    status: approved ? "done" : "error",
    lastMsg: approved
      ? `Approved ✓ (${diff.filesChanged.length} files)`
      : `Issues: ${(parsed.feedback ?? "").substring(0, 70)}...`,
  });

  return {
    approved,
    feedback: parsed.feedback || "",
    suggestions: parsed.suggestions || "",
    filesChanged: diff.filesChanged,
  };
}

/**
 * Master Surgery + Review loop.
 *
 * Architecture:
 * - ONE OpenCode server on port 3001
 * - TWO persistent sessions: coder + reviewer (never recreated)
 * - Coder session retains full change history across all passes
 * - Reviewer session retains all explored file context across all passes
 *
 * Per-pass flow:
 *   [Coder session] receives task / reviewer feedback → applies changes to disk
 *   [Reviewer session] reads git diff → greps blast radius → reads affected files → JSON verdict
 *   If rejected: feedback written to REPOORBIT_REVIEW.md + sent back to coder session
 *   Repeat until approved or MAX_SURGERY_LOOPS reached
 */
export async function runSurgeryReviewLoop(
  query: string,
  owner: string,
  repo: string,
  repoWorkDir: string,
  _ignoredPlan: string,          // kept for API compat — no longer used
  outDir: string,
  rootManifestContent: string,
  onStatus: (msg: string) => void,
  questionsUsed: Map<string, number>,
  updateAgent: (agent: any) => void,
): Promise<string> {
  writeOpencodeConfig(repoWorkDir);

  // Boot once, create two persistent sessions
  const { coderSessionId, reviewerSessionId } = await initLoopSessions(
    repoWorkDir,
    onStatus,
  );

  let lastResult = "";
  let reviewerFeedback = "";
  let isApproved = false;

  for (let loop = 0; loop < MAX_SURGERY_LOOPS; loop++) {
    onStatus(`Surgery+Review — Pass ${loop + 1}/${MAX_SURGERY_LOOPS}`);

    // ── CODER TURN ──────────────────────────────────────────────────────────
    // First pass: full task + manifest
    // Subsequent passes: reviewer feedback only (session already has full context)
    const operatorPrompt = getSurgeonPrompt({
      userQuery: query,
      repoManifest: loop === 0 ? rootManifestContent : undefined,
      reviewerFeedback: loop > 0 ? reviewerFeedback : undefined,
    });

    lastResult = await runOneSurgeryPass(
      coderSessionId,
      operatorPrompt,
      onStatus,
      updateAgent,
      loop + 1,
    );

    // ── VERIFICATION: Did the coder actually use tools? ─────────────────────
    const postSurgeryDiff = await getGitDiff(repoWorkDir);
    if (postSurgeryDiff.filesChanged.length === 0) {
      onStatus(`⚠️ Coder pass ${loop + 1} produced NO changes. Enforcing tool usage...`);
      const enforcementPrompt = "You provided a text response but did NOT call any tools to modify the code. You MUST use 'edit' or 'write' to apply the changes to the files. Do not just talk — perform the surgery now.";
      await runOneSurgeryPass(
        coderSessionId,
        enforcementPrompt,
        onStatus,
        updateAgent,
        loop + 1,
      );
    }

    // ── REVIEWER TURN ────────────────────────────────────────────────────────
    // Reviewer reads fresh git diff + uses its native tools to explore the
    // blast radius. Passes previous feedback so it knows what was already flagged.
    const review = await runPostSurgeryReview(
      reviewerSessionId,
      query,
      repoWorkDir,
      loop,
      reviewerFeedback,   // previous feedback so reviewer tracks what changed
      onStatus,
      updateAgent,
    );

    if (review.approved) {
      onStatus(`✓ Reviewer approved after pass ${loop + 1}.`);
      isApproved = true;
      break;
    }

    // ── FEEDBACK LOOP ────────────────────────────────────────────────────────
    const filesList =
      review.filesChanged.length > 0
        ? `**Files already modified (re-read these to check your previous work):**\n${review.filesChanged.map((f) => `- ${f}`).join("\n")}`
        : "No files were changed in the previous pass — you MUST write files this time.";

    onStatus(`Pass ${loop + 1} rejected — sending feedback to coder for refinement...`);

    reviewerFeedback = [
      `## Reviewer Feedback — Pass ${loop + 1}`,
      "",
      filesList,
      "",
      `### Issues Found`,
      review.feedback,
      "",
      `### Required Fixes`,
      review.suggestions,
    ].join("\n");

    // Write to disk so coder can also `cat REPOORBIT_REVIEW.md` directly
    fs.writeFileSync(
      path.join(repoWorkDir, "REPOORBIT_REVIEW.md"),
      reviewerFeedback,
      "utf-8",
    );

    console.log(
      `[SURGERY-LOOP] Pass ${loop + 1} rejected.\n${reviewerFeedback.slice(0, 500)}`,
    );
  }

  if (!isApproved) {
    onStatus("⚠️ Max passes reached — proceeding with best available state.");
  }

  // Cleanup temp files
  const reviewFile = path.join(repoWorkDir, "REPOORBIT_REVIEW.md");
  if (fs.existsSync(reviewFile)) fs.unlinkSync(reviewFile);

  return lastResult;
}
