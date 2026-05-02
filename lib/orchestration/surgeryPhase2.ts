import fs from "fs";
import path from "path";
import { Page } from "playwright";
import {
  createSession,
  sendToPort,
} from "@/lib/automation/opencode";
import {
  getTestGenerationPrompt,
  getGemmaTestRunnerPrompt,
  getGeminiDiskVerifierPrompt,
  getGemmaDiskOperatorPrompt,
} from "@/lib/prompts";
import { parseJsonFromText, lockPage } from "./utils";
import { askDeepseek } from "@/lib/automation/deepseek";
import { askQwen } from "@/lib/automation/qwen";
import { persistentPages } from "./globals";

export async function runSurgeryPhase2(
  owner: string,
  repo: string,
  repoWorkDir: string,
  finalAnswer: string,
  outDir: string,
  onStatus: (msg: string) => void,
  questionsUsed: Map<string, number>,
): Promise<string> {
  onStatus("Starting Phase 2: Gemma Disk Operator...");
  const architectFilePath = path.join(
    repoWorkDir,
    "final_architect_output.txt",
  );
  fs.writeFileSync(architectFilePath, finalAnswer, "utf-8");

  let gemmaFinalResult = "";
  let gemmaSubTurn = 0;
  const gemmaMaxSubTurns = 15;
  let gemmaLastAnswer = "";

  onStatus("Gemma (Port 3001) is initializing session...");
  const gemmaSessionId = await createSession(
    3001,
    repoWorkDir,
    "google/gemma-4-31b-it",
  );

  while (gemmaSubTurn < gemmaMaxSubTurns) {
    const used = questionsUsed.get("gemma") || 0;
    const questionsLeft = Math.max(0, 10 - used);

    const gemmaPrompt =
      gemmaSubTurn === 0
        ? getGemmaDiskOperatorPrompt({ architectFilePath, questionsLeft })
        : `Here is the answer to your previous inquiry: ${gemmaLastAnswer}\n\nPlease continue with applying the architect's changes.`;

    onStatus(`Gemma Sub-turn ${gemmaSubTurn} (A2A enabled)...`);
    const gemmaResult = await sendToPort(
      3001,
      gemmaSessionId,
      gemmaPrompt,
    );

    const gemmaJson = parseJsonFromText(gemmaResult);
    if (
      gemmaJson?.status === "AGENT_QUERY" &&
      gemmaJson.to &&
      gemmaJson.question
    ) {
      const targetRole = gemmaJson.to;
      const targetPage =
        targetRole === "coder_a"
          ? persistentPages.dsCoder
          : targetRole === "coder_b"
            ? persistentPages.qwenCoder
            : targetRole === "reviewer_a"
              ? persistentPages.dsReviewer
              : targetRole === "reviewer_b"
                ? persistentPages.qwenReviewer
                : targetRole === "architect"
                  ? persistentPages.dsSynthesizer
                  : null;

      if (!targetPage || used >= 10) {
        gemmaLastAnswer = "I cannot answer that right now.";
      } else {
        onStatus(`[Gemma] Querying ${targetRole}: ${gemmaJson.question}`);
        questionsUsed.set("gemma", used + 1);

        const targetModel =
          targetRole === "coder_a" ||
          targetRole === "reviewer_a" ||
          targetRole === "architect"
            ? "DeepSeek"
            : "Qwen";

        const answerPrompt = `### AGENT-TO-AGENT INQUIRY
From: Gemma (Disk Operator)
Context: ${gemmaJson.context || "No extra context provided"}
Question: ${gemmaJson.question}

Please provide a clear, technical answer. Output ONLY the answer text.`;

        const releaseTargetPage = await lockPage(
          targetPage!,
          `${targetRole} inquiry from Gemma`,
        );
        try {
          if (targetModel === "DeepSeek") {
            gemmaLastAnswer = await askDeepseek(
              targetPage!,
              answerPrompt,
              "N/A (Disk inquiry)",
              "",
              () => {},
              outDir,
              false,
            );
          } else {
            gemmaLastAnswer = await askQwen(
              targetPage!,
              answerPrompt,
              "",
              () => {},
              outDir,
              false,
            );
          }
        } finally {
          releaseTargetPage();
        }
      }
    } else if (gemmaJson?.status === "DONE") {
      gemmaFinalResult = gemmaJson.report || gemmaResult;
      break;
    } else {
      gemmaFinalResult = gemmaResult;
      break;
    }
    gemmaSubTurn++;
  }

  // Test Gen
  onStatus("Generating tests from 4 primary models (diverse perspectives)...");
  
  const [testDsCoder, testQwCoder, testDsRev, testQwRev] = await Promise.all([
    askDeepseek(
      persistentPages.dsCoder!,
      getTestGenerationPrompt({ architectOutput: finalAnswer, role: "DeepSeek Coder" }),
      "N/A (Test Generation)",
      "",
      () => {},
      outDir,
      false
    ),
    askQwen(
      persistentPages.qwenCoder!,
      getTestGenerationPrompt({ architectOutput: finalAnswer, role: "Qwen Coder" }),
      "",
      () => {},
      outDir,
      false
    ),
    askDeepseek(
      persistentPages.dsReviewer!,
      getTestGenerationPrompt({ architectOutput: finalAnswer, role: "DeepSeek Reviewer" }),
      "N/A (Test Generation)",
      "",
      () => {},
      outDir,
      false
    ),
    askQwen(
      persistentPages.qwenReviewer!,
      getTestGenerationPrompt({ architectOutput: finalAnswer, role: "Qwen Reviewer" }),
      "",
      () => {},
      outDir,
      false
    )
  ]);

  const combinedTests = [
    `=== DEEPSEEK CODER TESTS ===\n${testDsCoder}`,
    `=== QWEN CODER TESTS ===\n${testQwCoder}`,
    `=== DEEPSEEK REVIEWER TESTS ===\n${testDsRev}`,
    `=== QWEN REVIEWER TESTS ===\n${testQwRev}`,
  ].join("\n\n");

  const testsFilePath = path.join(repoWorkDir, "generated_tests.txt");
  const testsLogsPath = path.join(repoWorkDir, "Test_log.txt");
  fs.writeFileSync(testsFilePath, combinedTests, "utf-8");

  onStatus("Gemma (Port 3001) is executing the test suite...");
  const gemmaTestSessionId = await createSession(
    3001,
    repoWorkDir,
    "google/gemma-4-31b-it",
  );
  const gemmaTestPrompt = getGemmaTestRunnerPrompt({ testsFilePath });
  const gemmaTestResult = await sendToPort(
    3001,
    gemmaTestSessionId,
    gemmaTestPrompt,
  );
  if (!fs.existsSync(testsLogsPath)) {
    fs.writeFileSync(testsLogsPath, gemmaTestResult, "utf-8");
  }

  onStatus("Starting Phase 3: Gemini Flash Review...");
  const flashSessionId = await createSession(
    3001,
    repoWorkDir,
    "google/gemini-2.5-flash",
  );
  const combinedGemmaOutput = [
    `[GEMMA DISK OPERATOR LOGS]\n${gemmaFinalResult}`,
    `[GEMMA TEST RUNNER LOGS]\n${gemmaTestResult}`,
    `[TESTS LOG PATH] ${testsLogsPath}`,
  ].join("\n\n");
  const flashPrompt = getGeminiDiskVerifierPrompt({
    gemmaOutput: combinedGemmaOutput,
    architectFilePath: architectFilePath,
  });

  return await sendToPort(3001, flashSessionId, flashPrompt);
}
