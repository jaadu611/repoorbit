import fs from "fs";
import path from "path";
import { getSoloCodingPrompt, getReviewerPrompt } from "@/lib/prompts";
import { runSingleModelTurn } from "./agents";
import { DEFAULT_MODEL, NVIDIA_MODEL } from "@/lib/automation/llm";
import { parseJsonFromText } from "./utils";

export async function runSoloOrchestration(
  query: string,
  owner: string,
  repo: string,
  defaultBranch: string,
  outDir: string,
  contextDir: string,
  rootManifestContent: string,
  onStatus: (msg: string) => void,
  questionsUsed: Map<string, number>,
  updateAgent: (agent: any) => void,
): Promise<string> {
  const model: NVIDIA_MODEL = DEFAULT_MODEL; // The strongest model for solo work

  let previousResponse = "";
  let currentPlanText = "";
  let isApproved = false;

  const MAX_ITERATIONS = 5; // Reduced to be more efficient but higher quality
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    onStatus(`SOLO PASS — Drafting Iteration ${iteration + 1}...`);

    // --- STEP 1: DRAFTING ---
    const turn = await runSingleModelTurn(
      model,
      () => getSoloCodingPrompt({
        userQuery: query,
        previousResponse,
        iteration
      }),
      path.join(outDir, `draft_${iteration}`),
      contextDir,
      owner,
      repo,
      defaultBranch,
      rootManifestContent,
      onStatus,
      "",
      `solo_engineer`,
      questionsUsed,
      updateAgent,
      true
    );

    const draftResponse = parseJsonFromText(turn.answer) || {
      summary: turn.answer,
      files: {},
      done: true
    };
    
    let draftPlanText = "";
    if (draftResponse.files && Object.keys(draftResponse.files).length > 0) {
      for (const [filename, fileObj] of Object.entries(draftResponse.files)) {
        draftPlanText += `// ${filename}\n// ── BEGIN CHANGE ────────────────────────────────────────\n${(fileObj as any).content}\n// ── END CHANGE ──────────────────────────────────────────\n\n`;
      }
    } else {
      // Nag the model if it finished without providing files
      onStatus("Draft was empty. Forcing refinement...");
      previousResponse = `### CRITICAL ERROR\nYour previous response contained NO file changes in the "files" object. You MUST provide the full content of the modified files in the "files" object for the changes to be applied. Do not just run commands; output the final code.`;
    }
    
    if (draftPlanText) currentPlanText = draftPlanText;
    previousResponse = turn.answer;

    // --- STEP 2: SELF-REVIEW ---
    onStatus(`SOLO PASS — Reviewing Iteration ${iteration + 1}...`);
    const reviewTurn = await runSingleModelTurn(
      model,
      () => getReviewerPrompt({
        userQuery: query,
        gitDiff: currentPlanText || draftResponse.summary || turn.answer,
        passNumber: iteration + 1,
        previousFeedback: iteration > 0 ? undefined : undefined,
      }),
      path.join(outDir, `review_${iteration}`),
      contextDir,
      owner,
      repo,
      defaultBranch,
      rootManifestContent,
      onStatus,
      "",
      `reviewer`,
      questionsUsed,
      updateAgent,
      true
    );

    const reviewResult = parseJsonFromText(reviewTurn.answer) || { has_issues: true, feedback: "Failed to parse review." };
    
    if (!reviewResult.has_issues || reviewResult.feedback?.toUpperCase().includes("PERFECT")) {
      onStatus("Review passed! Finalizing...");
      isApproved = true;
      break;
    } else {
      onStatus(`Review found issues: ${reviewResult.feedback.substring(0, 50)}...`);
      // Inject feedback into previousResponse for next iteration
      previousResponse = `### REVIEW FEEDBACK\n${reviewResult.feedback}\n\n### SUGGESTIONS\n${reviewResult.suggestions}\n\n### PREVIOUS DRAFT\n${turn.answer}`;
    }
  }

  // Finalize for Surgery Phase 2
  if (!currentPlanText && previousResponse) {
    // Fallback if no files were found but we have a response
    currentPlanText = previousResponse;
  }

  fs.writeFileSync(path.join(outDir, "combined_response.txt"), currentPlanText, "utf-8");
  return currentPlanText;
}
