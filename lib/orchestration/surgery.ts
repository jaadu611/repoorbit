import fs from "fs";
import path from "path";
import { BrowserContext } from "playwright";
import {
  getDeepseekCodingPrompt,
  getCoderRefinementPrompt,
  getCodeReviewPrompt,
  getSynthesisPrompt,
  getReviewSynthesisPrompt,
  getFinalArchitectureSynthesisPrompt,
} from "@/lib/prompts";
import { runSingleModelTurn, qwenCombine } from "./agents";
import { persistentPages } from "./globals";

/**
 * Initial synthesis phase with Coder-Reviewer loop.
 */
export async function runInitialSynthesis(
  query: string,
  owner: string,
  repo: string,
  defaultBranch: string,
  outDir: string,
  dsBaseContextDir: string,
  rootManifestContent: string,
  _context: BrowserContext,
  onStatus: (msg: string) => void,
  questionsUsed: Map<string, number>,
): Promise<string> {
  let currentIteration = 0;
  let latestReviewFeedback = "";
  let latestCombinedCoderPath = "";
  let hasIssues = true;

  // Persist root manifest to outDir for reference
  fs.writeFileSync(
    path.join(outDir, "00_Root_Manifest.txt"),
    rootManifestContent,
    "utf-8",
  );

  while (hasIssues) {
    onStatus(`Coder-Reviewer Loop — Iteration ${currentIteration}...`);

    const dsCoderInvestDir = path.join(
      outDir,
      `invest_ds_coder_${currentIteration}`,
    );
    const qwenCoderInvestDir = path.join(
      outDir,
      `invest_qwen_coder_${currentIteration}`,
    );
    const dsRevInvestDir = path.join(
      outDir,
      `invest_ds_reviewer_${currentIteration}`,
    );
    const qwenRevInvestDir = path.join(
      outDir,
      `invest_qwen_reviewer_${currentIteration}`,
    );

    [
      dsCoderInvestDir,
      qwenCoderInvestDir,
      dsRevInvestDir,
      qwenRevInvestDir,
    ].forEach((d) => fs.mkdirSync(d, { recursive: true }));

    const dsCoderFilled = new Set<string>();
    const qwenCoderFilled = new Set<string>();
    const dsRevFilled = new Set<string>();
    const qwenRevFilled = new Set<string>();

    // 1. Parallel Coders
    onStatus(
      `Researcher — Iteration ${currentIteration}: Gathering parallel implementation drafts...`,
    );

    // For Iteration 0, we use the base context (manifest/exploration results)
    // For Iteration 1+, we use the same base context + previous review feedback
    const coderUploadDir = path.join(
      outDir,
      `coder_upload_${currentIteration}`,
    );
    fs.mkdirSync(coderUploadDir, { recursive: true });

    // Copy base context (exploration results)
    for (const f of fs.readdirSync(dsBaseContextDir)) {
      fs.copyFileSync(
        path.join(dsBaseContextDir, f),
        path.join(coderUploadDir, f),
      );
    }
    // Explicitly add root manifest (only once per session)
    if (currentIteration === 0) {
      fs.writeFileSync(
        path.join(coderUploadDir, "00_Root_Manifest.txt"),
        rootManifestContent,
        "utf-8",
      );
    }

    // If we have previous reviews, provide them to coders
    if (latestReviewFeedback) {
      fs.writeFileSync(
        path.join(coderUploadDir, "combined_reviews.txt"),
        latestReviewFeedback,
        "utf-8",
      );
      // Also provide the previous merged fix so they can see the baseline
      if (latestCombinedCoderPath && fs.existsSync(latestCombinedCoderPath)) {
        fs.copyFileSync(
          latestCombinedCoderPath,
          path.join(coderUploadDir, "combined_response.txt"),
        );
      }
    }

    const [dsCoderRaw, qwenCoderRaw] = await Promise.all([
      runSingleModelTurn(
        "DeepSeek",
        null, // No page needed for API
        (qLeft) =>
          currentIteration === 0
            ? getDeepseekCodingPrompt({ userQuery: query })
            : getCoderRefinementPrompt({
                userQuery: query,
                owner,
                repo,
                defaultBranch,
                hasLatestResponse: !!latestCombinedCoderPath,
              }),
        coderUploadDir,
        dsCoderInvestDir,
        dsCoderFilled,
        outDir,
        owner,
        repo,
        defaultBranch,
        rootManifestContent,
        onStatus,
        latestCombinedCoderPath,
        "coder_a",
        questionsUsed,
      ),
      runSingleModelTurn(
        "Qwen",
        persistentPages.qwenCoder!,
        (qLeft) =>
          currentIteration === 0
            ? getDeepseekCodingPrompt({ userQuery: query })
            : getCoderRefinementPrompt({
                userQuery: query,
                owner,
                repo,
                defaultBranch,
                hasLatestResponse: !!latestCombinedCoderPath,
              }),
        coderUploadDir,
        qwenCoderInvestDir,
        qwenCoderFilled,
        outDir,
        owner,
        repo,
        defaultBranch,
        rootManifestContent,
        onStatus,
        latestCombinedCoderPath,
        "coder_b",
        questionsUsed,
      ),
    ]);

    // 2. Combine Coders
    const rawCoderBlock = [
      "// CODER_A RESPONSE",
      dsCoderRaw || "// [No response]",
      "",
      "// CODER_B RESPONSE",
      qwenCoderRaw || "// [No response]",
    ].join("\n");

    const rawCoderPath = path.join(
      outDir,
      `raw_coder_iteration_${currentIteration}.txt`,
    );
    fs.writeFileSync(rawCoderPath, rawCoderBlock, "utf-8");

    onStatus(
      `Synthesizer — Iteration ${currentIteration}: Merging coder proposals...`,
    );
    const combinedCoderPath = path.join(
      outDir,
      `combined_coder_iteration_${currentIteration}.txt`,
    );
    const combinedCoderContent = await qwenCombine(
      (qLeft) =>
        getSynthesisPrompt({
          synthesisPrompt: query,
          latestReview: latestReviewFeedback,
        }),
      [rawCoderPath],
      "Coder Synthesis",
      outDir,
      onStatus,
      questionsUsed,
      latestReviewFeedback,
    );
    fs.writeFileSync(combinedCoderPath, combinedCoderContent, "utf-8");
    latestCombinedCoderPath = combinedCoderPath;

    // 3. Parallel Reviewers
    onStatus(
      `Reviewer — Iteration ${currentIteration}: Reviewing merged proposal...`,
    );

    const reviewerUploadDir = path.join(
      outDir,
      `reviewer_upload_${currentIteration}`,
    );
    fs.mkdirSync(reviewerUploadDir, { recursive: true });
    fs.copyFileSync(
      combinedCoderPath,
      path.join(reviewerUploadDir, "combined_responses.txt"),
    );
    // Explicitly add root manifest for reviewers too (only once per session)
    if (currentIteration === 0) {
      fs.writeFileSync(
        path.join(reviewerUploadDir, "00_Root_Manifest.txt"),
        rootManifestContent,
        "utf-8",
      );
    }

    const [dsRevRaw, qwenRevRaw] = await Promise.all([
      runSingleModelTurn(
        "DeepSeek",
        null, // No page needed for API
        (qLeft) =>
          getCodeReviewPrompt({ userQuery: query, owner, repo, defaultBranch }),
        reviewerUploadDir,
        dsRevInvestDir,
        dsRevFilled,
        outDir,
        owner,
        repo,
        defaultBranch,
        rootManifestContent,
        onStatus,
        combinedCoderPath,
        "reviewer_a",
        questionsUsed,
      ),
      runSingleModelTurn(
        "Qwen",
        persistentPages.qwenReviewer!,
        (qLeft) =>
          getCodeReviewPrompt({ userQuery: query, owner, repo, defaultBranch }),
        reviewerUploadDir,
        qwenRevInvestDir,
        qwenRevFilled,
        outDir,
        owner,
        repo,
        defaultBranch,
        rootManifestContent,
        onStatus,
        combinedCoderPath,
        "reviewer_b",
        questionsUsed,
      ),
    ]);

    // 4. Combine Reviews
    const rawReviewBlock = [
      "// REVIEWER_A FEEDBACK",
      dsRevRaw || "// [No response]",
      "",
      "// REVIEWER_B FEEDBACK",
      qwenRevRaw || "// [No response]",
    ].join("\n");

    const rawReviewPath = path.join(
      outDir,
      `raw_review_iteration_${currentIteration}.txt`,
    );
    fs.writeFileSync(rawReviewPath, rawReviewBlock, "utf-8");

    onStatus(
      `Synthesizer — Iteration ${currentIteration}: Synthesizing reviews...`,
    );
    latestReviewFeedback = await qwenCombine(
      () => getReviewSynthesisPrompt(),
      [rawReviewPath],
      "Review Synthesis",
      outDir,
      onStatus,
      questionsUsed,
    );

    // 5. Check Termination
    hasIssues = latestReviewFeedback.toUpperCase().includes("HAS_ISSUES: YES");
    onStatus(
      `Iteration ${currentIteration} Complete. Has Issues: ${hasIssues ? "YES" : "NO"}`,
    );

    if (!hasIssues) break;
    currentIteration++;
  }

  // 6. Final Architecture Synthesis (Chief Architect)
  onStatus("Synthesizer — Drafting final architect plan...");
  // Gather all final inputs
  const allCoders = fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith("raw_coder_iteration_"))
    .sort()
    .map((f) => fs.readFileSync(path.join(outDir, f), "utf-8"))
    .join("\n\n---\n\n");
  const allReviews = fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith("raw_review_iteration_"))
    .sort()
    .map((f) => fs.readFileSync(path.join(outDir, f), "utf-8"))
    .join("\n\n---\n\n");

  const finalCoderInput = path.join(outDir, "final_all_coders.txt");
  const finalReviewInput = path.join(outDir, "final_all_reviews.txt");
  fs.writeFileSync(finalCoderInput, allCoders, "utf-8");
  fs.writeFileSync(finalReviewInput, allReviews, "utf-8");

  const finalPlan = await qwenCombine(
    (qLeft) =>
      getFinalArchitectureSynthesisPrompt({
        query,
        allCoderResponses: "[See attached final_all_coders.txt]",
        allReviewerResponses: "[See attached final_all_reviews.txt]",
      }),
    [finalCoderInput, finalReviewInput],
    "Final Architecture Synthesis",
    outDir,
    onStatus,
    questionsUsed,
  );

  return finalPlan;
}
