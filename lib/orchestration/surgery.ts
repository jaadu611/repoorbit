import fs from "fs";
import path from "path";
import { BrowserContext } from "playwright";
import {
  getDeepseekCodingPrompt,
  getGeminiSynthesisPrompt,
  getCodeReviewPrompt,
  getReviewSynthesisPrompt,
  getCoderRefinementPrompt,
  getFinalPolishPrompt,
  AGENT_COMMUNICATION_PROTOCOL,
} from "@/lib/prompts";
import { runSingleModelTurn, deepseekCombine } from "./agents";
import { MAX_ROUNDS } from "./constants";
import { activeJobs, persistentPages } from "./globals";

export async function runCoderReviewerLoop(
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
  const dsCoderInvestDir = path.join(outDir, "invest_ds_coder");
  const qwenCoderInvestDir = path.join(outDir, "invest_qwen_coder");
  const dsReviewInvestDir = path.join(outDir, "invest_ds_reviewer");
  const qwenReviewInvestDir = path.join(outDir, "invest_qwen_reviewer");
  
  [
    dsCoderInvestDir,
    qwenCoderInvestDir,
    dsReviewInvestDir,
    qwenReviewInvestDir,
  ].forEach((d) => fs.mkdirSync(d, { recursive: true }));

  const dsCoderFilled = new Set<string>();
  const qwenCoderFilled = new Set<string>();
  const dsReviewFilled = new Set<string>();
  const qwenReviewFilled = new Set<string>();

  let coderFirstTurn = true;
  let activeResponsePath = "";
  let finalSynthesis = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    onStatus(`=== Round ${round} ===`);

    const coderPromptGenerator = (questionsLeft: number) =>
      round === 0
        ? getDeepseekCodingPrompt({
            userQuery: query,
            mode: "FIX",
            communicationContext: AGENT_COMMUNICATION_PROTOCOL(
              "coder_a",
              questionsLeft,
            ),
          })
        : getCoderRefinementPrompt({
            userQuery: query,
            owner,
            repo,
            defaultBranch,
            hasLatestResponse: !!activeResponsePath,
            communicationContext: AGENT_COMMUNICATION_PROTOCOL(
              "coder_a",
              questionsLeft,
            ),
          });

    const coderPromptGeneratorQwen = (questionsLeft: number) =>
      round === 0
        ? getDeepseekCodingPrompt({
            userQuery: query,
            mode: "FIX",
            communicationContext: AGENT_COMMUNICATION_PROTOCOL(
              "coder_b",
              questionsLeft,
            ),
          })
        : getCoderRefinementPrompt({
            userQuery: query,
            owner,
            repo,
            defaultBranch,
            hasLatestResponse: !!activeResponsePath,
            communicationContext: AGENT_COMMUNICATION_PROTOCOL(
              "coder_b",
              questionsLeft,
            ),
          });

    let coderUploadDir: string | null = null;
    if (coderFirstTurn) {
      coderUploadDir = path.join(outDir, "coder_upload_round0");
      if (fs.existsSync(coderUploadDir))
        fs.rmSync(coderUploadDir, { recursive: true, force: true });
      fs.mkdirSync(coderUploadDir, { recursive: true });
      for (const f of fs.readdirSync(dsBaseContextDir)) {
        if (f === "gap_filler.txt") continue;
        fs.copyFileSync(
          path.join(dsBaseContextDir, f),
          path.join(coderUploadDir, f),
        );
      }
    } else {
      const reviewPath = path.join(outDir, `combined_review_${round - 1}.txt`);
      if (fs.existsSync(reviewPath)) {
        coderUploadDir = path.join(outDir, `coder_upload_round${round}`);
        if (fs.existsSync(coderUploadDir))
          fs.rmSync(coderUploadDir, { recursive: true, force: true });
        fs.mkdirSync(coderUploadDir, { recursive: true });
        fs.copyFileSync(
          reviewPath,
          path.join(coderUploadDir, path.basename(reviewPath)),
        );
      }
    }

    onStatus(`Round ${round}: Running both coders in parallel...`);
    const [dsCoderRaw, qwenCoderRaw] = await Promise.all([
      runSingleModelTurn(
        "DeepSeek",
        persistentPages.dsCoder!,
        coderPromptGenerator,
        coderUploadDir,
        dsCoderInvestDir,
        dsCoderFilled,
        outDir,
        owner,
        repo,
        defaultBranch,
        rootManifestContent,
        onStatus,
        activeResponsePath,
        "coder_a",
        questionsUsed,
      ),
      runSingleModelTurn(
        "Qwen",
        persistentPages.qwenCoder!,
        coderPromptGeneratorQwen,
        coderUploadDir,
        qwenCoderInvestDir,
        qwenCoderFilled,
        outDir,
        owner,
        repo,
        defaultBranch,
        rootManifestContent,
        onStatus,
        activeResponsePath,
        "coder_b",
        questionsUsed,
      ),
    ]);
    coderFirstTurn = false;

    if (coderUploadDir && fs.existsSync(coderUploadDir)) {
      try {
        fs.rmSync(coderUploadDir, { recursive: true, force: true });
      } catch {}
    }

    const rawCoderBlock = [
      `// CODER_A (DeepSeek) — Round ${round}`,
      dsCoderRaw || "// [No response]",
      "",
      `// CODER_B (Qwen) — Round ${round}`,
      qwenCoderRaw || "// [No response]",
    ].join("\n");

    const rawCoderPath = path.join(
      outDir,
      `combined_response_raw_${round}.txt`,
    );
    fs.writeFileSync(rawCoderPath, rawCoderBlock, "utf-8");

    const coderSynthesis = await deepseekCombine(
      (questionsLeft) =>
        getGeminiSynthesisPrompt({
          synthesisPrompt: query,
          latestReview: round > 0 ? finalSynthesis : undefined,
          communicationContext: AGENT_COMMUNICATION_PROTOCOL(
            "architect",
            questionsLeft,
          ),
        }),
      [rawCoderPath],
      `Synthesizing coder outputs (round ${round})`,
      outDir,
      onStatus,
      questionsUsed,
      round > 0 ? finalSynthesis : undefined,
    );

    activeResponsePath = path.join(outDir, `combined_response_${round}.txt`);
    fs.writeFileSync(activeResponsePath, coderSynthesis, "utf-8");

    const debugResponsePath = path.join(
      outDir,
      `combined_response_debug_${round}.txt`,
    );
    fs.writeFileSync(
      debugResponsePath,
      [
        rawCoderBlock,
        "=".repeat(60) + "\n",
        `// DEEPSEEK SYNTHESIS — ROUND ${round}`,
        "=".repeat(60) + "\n\n",
        coderSynthesis,
      ].join("\n"),
      "utf-8",
    );

    activeJobs.forEach((job, id) => {
      if (
        job.statusText?.includes("coder") ||
        job.statusText?.includes("Round")
      ) {
        activeJobs.set(id, {
          ...job,
          result: coderSynthesis,
          answerSource: "initial",
        });
      }
    });

    const reviewerPromptGenerator = (questionsLeft: number) =>
      getCodeReviewPrompt({
        userQuery: query,
        owner,
        repo,
        defaultBranch,
        communicationContext: AGENT_COMMUNICATION_PROTOCOL(
          "reviewer_a",
          questionsLeft,
        ),
      });

    const reviewerPromptGeneratorQwen = (questionsLeft: number) =>
      getCodeReviewPrompt({
        userQuery: query,
        owner,
        repo,
        defaultBranch,
        communicationContext: AGENT_COMMUNICATION_PROTOCOL(
          "reviewer_b",
          questionsLeft,
        ),
      });

    const reviewerUploadDir = path.join(
      outDir,
      `reviewer_upload_round${round}`,
    );
    if (fs.existsSync(reviewerUploadDir))
      fs.rmSync(reviewerUploadDir, { recursive: true, force: true });
    fs.mkdirSync(reviewerUploadDir, { recursive: true });
    fs.copyFileSync(
      activeResponsePath,
      path.join(reviewerUploadDir, path.basename(activeResponsePath)),
    );

    onStatus(`Round ${round}: Running both reviewers in parallel...`);
    const [dsReviewRaw, qwenReviewRaw] = await Promise.all([
      runSingleModelTurn(
        "DeepSeek",
        persistentPages.dsReviewer!,
        reviewerPromptGenerator,
        reviewerUploadDir,
        dsReviewInvestDir,
        dsReviewFilled,
        outDir,
        owner,
        repo,
        defaultBranch,
        rootManifestContent,
        onStatus,
        activeResponsePath,
        "reviewer_a",
        questionsUsed,
      ),
      runSingleModelTurn(
        "Qwen",
        persistentPages.qwenReviewer!,
        reviewerPromptGeneratorQwen,
        reviewerUploadDir,
        qwenReviewInvestDir,
        qwenReviewFilled,
        outDir,
        owner,
        repo,
        defaultBranch,
        rootManifestContent,
        onStatus,
        activeResponsePath,
        "reviewer_b",
        questionsUsed,
      ),
    ]);

    if (fs.existsSync(reviewerUploadDir)) {
      try {
        fs.rmSync(reviewerUploadDir, { recursive: true, force: true });
      } catch {}
    }

    const rawReviewBlock = [
      `// REVIEWER_A (DeepSeek) — Round ${round}`,
      dsReviewRaw || "// [No response]",
      "",
      `// REVIEWER_B (Qwen) — Round ${round}`,
      qwenReviewRaw || "// [No response]",
    ].join("\n");

    const rawReviewPath = path.join(outDir, `combined_review_raw_${round}.txt`);
    fs.writeFileSync(rawReviewPath, rawReviewBlock, "utf-8");

    const reviewSynthesis = await deepseekCombine(
      (questionsLeft) =>
        getReviewSynthesisPrompt({
          communicationContext: AGENT_COMMUNICATION_PROTOCOL(
            "architect",
            questionsLeft,
          ),
        }),
      [rawReviewPath],
      `Synthesizing reviewer outputs (round ${round})`,
      outDir,
      onStatus,
      questionsUsed,
    );

    const combinedReviewPath = path.join(
      outDir,
      `combined_review_${round}.txt`,
    );
    fs.writeFileSync(
      combinedReviewPath,
      [
        rawReviewBlock,
        "=".repeat(60) + "\n",
        `// DEEPSEEK REVIEW SYNTHESIS — ROUND ${round}`,
        "=".repeat(60) + "\n\n",
        reviewSynthesis,
      ].join("\n"),
      "utf-8",
    );

    finalSynthesis = reviewSynthesis;
    const hasIssues = /HAS_ISSUES:\s*YES/i.test(reviewSynthesis);
    onStatus(`Round ${round} verdict — HAS_ISSUES: ${hasIssues}`);

    if (!hasIssues) {
      onStatus(
        `Round ${round}: Reviewers satisfied. Loop complete after ${round + 1} round(s).`,
      );
      break;
    }

    if (round + 1 >= MAX_ROUNDS) {
      onStatus("Max rounds reached. Returning best available answer.");
      break;
    }

    onStatus(
      `Round ${round}: Issues found — coders will refine in round ${round + 1}.`,
    );
  }

  onStatus("Performing final code polish...");
  const polishedAnswer = await deepseekCombine(
    () => getFinalPolishPrompt(),
    [activeResponsePath],
    "Final Polish",
    outDir,
    onStatus,
    questionsUsed,
    finalSynthesis,
  );

  return polishedAnswer;
}
