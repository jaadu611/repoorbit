import fs from "fs";
import path from "path";
import { Page } from "playwright";
import { askDeepseek } from "@/lib/automation/deepseek";
import { askQwen } from "@/lib/automation/qwen";
import { persistentPages } from "./globals";
import { parseJsonFromText, fileFingerprint, lockPage } from "./utils";
import { fillMissingFiles } from "./context";
import { AGENT_QUESTION_LIMIT, ARCHITECT_QUESTION_LIMIT } from "./constants";

export async function runSingleModelTurn(
  role: "DeepSeek" | "Qwen",
  page: Page,
  promptGenerator: (questionsLeft: number) => string,
  uploadDir: string | null,
  investDir: string,
  filledSet: Set<string>,
  outDir: string,
  owner: string,
  repo: string,
  branch: string,
  manifestContent: string,
  onStatus: (msg: string) => void,
  latestResponsePath: string | undefined,
  agentRole: string,
  questionsUsed: Map<string, number>,
): Promise<string> {
  let done = false;
  let attempt = 0;
  let raw = "";
  const uploadedHashes = new Map<string, string>();

  while (!done && attempt < 20) {
    let effectiveUploadDir: string | null = null;

    if (attempt === 0 && uploadDir) {
      effectiveUploadDir = uploadDir;
      if (fs.existsSync(uploadDir)) {
        for (const f of fs.readdirSync(uploadDir)) {
          const src = path.join(uploadDir, f);
          if (fs.statSync(src).isFile())
            uploadedHashes.set(f, fileFingerprint(src));
        }
      }
    } else {
      const extraTurnDir = path.join(
        outDir,
        `${role.toLowerCase()}_extra_${attempt}_${Date.now()}`,
      );
      const newFiles: { src: string; dstName: string }[] = [];
      if (fs.existsSync(investDir)) {
        for (const f of fs.readdirSync(investDir)) {
          const src = path.join(investDir, f);
          if (!fs.statSync(src).isFile()) continue;
          const fp = fileFingerprint(src);
          if (uploadedHashes.get(f) === fp) continue;
          newFiles.push({ src, dstName: f });
        }
      }
      if (newFiles.length > 0) {
        fs.mkdirSync(extraTurnDir, { recursive: true });
        for (const item of newFiles) {
          fs.copyFileSync(item.src, path.join(extraTurnDir, item.dstName));
          uploadedHashes.set(item.dstName, fileFingerprint(item.src));
        }
        effectiveUploadDir = extraTurnDir;
      }
    }

    const questionsUsedCount = questionsUsed.get(agentRole) || 0;
    const questionsLeft = Math.max(0, AGENT_QUESTION_LIMIT - questionsUsedCount);

    const turnPrompt =
      attempt === 0
        ? promptGenerator(questionsLeft)
        : "Here is the result of your previous request. Please continue.";

    onStatus(`[${role}] Sub-turn ${attempt}...`);

    try {
      const releaseOwnPage = await lockPage(page, `${role} main turn`);
      try {
        if (role === "DeepSeek") {
          raw = await askDeepseek(
            page,
            turnPrompt,
            manifestContent,
            effectiveUploadDir || "",
            (msg) => onStatus(`[${role}] ${msg}`),
            outDir,
            attempt === 0,
          );
        } else {
          raw = await askQwen(
            page,
            turnPrompt,
            effectiveUploadDir || "",
            (msg) => onStatus(`[${role}] ${msg}`),
            outDir,
            attempt === 0,
          );
        }
      } finally {
        releaseOwnPage();
      }

      const json = parseJsonFromText(raw);
      if (json?.status === "AGENT_QUERY" && json.to && json.question) {
        const targetRole = json.to;
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

        if (!targetPage) {
          console.warn(`[ORCHESTRATOR] Invalid target agent: ${targetRole}`);
          attempt++;
          continue;
        }

        const used = questionsUsed.get(agentRole) || 0;
        if (used >= AGENT_QUESTION_LIMIT) {
          onStatus(`[${agentRole}] Quota exhausted. Question blocked.`);
          attempt++;
          continue;
        }

        onStatus(`[${agentRole}] Querying ${targetRole}: ${json.question}`);
        questionsUsed.set(agentRole, used + 1);

        const targetModel =
          targetRole === "coder_a" ||
          targetRole === "reviewer_a" ||
          targetRole === "architect"
            ? "DeepSeek"
            : "Qwen";

        const answerPrompt = `### AGENT-TO-AGENT INQUIRY
From: ${agentRole}
Context: ${json.context || "No extra context provided"}
Question: ${json.question}

Please provide a clear, technical answer. Output ONLY the answer text.`;

        const releaseTargetPage = await lockPage(
          targetPage,
          `${targetRole} inquiry`,
        );
        let answer = "";
        try {
          if (targetModel === "DeepSeek") {
            answer = await askDeepseek(
              targetPage,
              answerPrompt,
              manifestContent,
              "",
              (msg) => onStatus(`[${targetRole} REPLY] ${msg}`),
              outDir,
              false,
            );
          } else {
            answer = await askQwen(
              targetPage,
              answerPrompt,
              "",
              (msg) => onStatus(`[${targetRole} REPLY] ${msg}`),
              outDir,
              false,
            );
          }
        } finally {
          releaseTargetPage();
        }

        const answerFileName = `a2a_reply_${attempt}_from_${targetRole}.txt`;
        fs.writeFileSync(
          path.join(investDir, answerFileName),
          `REPLY FROM ${targetRole}:\n\n${answer}`,
          "utf-8",
        );
        attempt++;
        continue;
      }

      if (json?.status === "NEED_MORE_CONTEXT") {
        const mFiles = json.missing_files || json.missing_symbols || [];
        const fetched = await fillMissingFiles(
          mFiles,
          filledSet,
          role,
          investDir,
          owner,
          repo,
          branch,
          outDir,
          latestResponsePath,
        );
        if (fetched === 0) {
          onStatus(`[${role}] No new files fetched. Finishing.`);
          done = true;
        }
      } else {
        done = true;
      }
    } catch (err: any) {
      onStatus(
        `[${role}] CRITICAL: Sub-turn ${attempt} failed: ${err.message}`,
      );
      done = true;
      break;
    } finally {
      if (
        attempt > 0 &&
        effectiveUploadDir &&
        fs.existsSync(effectiveUploadDir)
      ) {
        try {
          fs.rmSync(effectiveUploadDir, { recursive: true, force: true });
        } catch {}
      }
    }

    attempt++;
  }

  return raw;
}

export async function deepseekCombine(
  promptGenerator: (questionsLeft: number) => string,
  filesToAttach: string[],
  stepLabel: string,
  outDir: string,
  onStatus: (msg: string) => void,
  questionsUsed: Map<string, number>,
  latestReview?: string,
): Promise<string> {
  onStatus(`[DeepSeek] ${stepLabel}...`);
  const synthDir = path.join(outDir, `synth_${Date.now()}`);
  fs.mkdirSync(synthDir, { recursive: true });
  for (const f of filesToAttach) {
    fs.copyFileSync(f, path.join(synthDir, path.basename(f)));
  }

  if (latestReview) {
    fs.writeFileSync(
      path.join(synthDir, "latest_review.txt"),
      latestReview,
      "utf-8",
    );
  }

  let done = false;
  let attempt = 0;
  let res = "";

  while (!done && attempt < 10) {
    const used = questionsUsed.get("architect") || 0;
    const questionsLeft = Math.max(0, ARCHITECT_QUESTION_LIMIT - used);
    const turnPrompt =
      attempt === 0
        ? promptGenerator(questionsLeft)
        : "Here is the answer to your previous query. Please continue with the synthesis.";

    const releaseOwnPage = await lockPage(
      persistentPages.dsSynthesizer!,
      `architect synthesis`,
    );
    try {
      res = await askDeepseek(
        persistentPages.dsSynthesizer!,
        turnPrompt,
        "",
        attempt === 0 ? synthDir : "",
        (msg) => onStatus(`[DeepSeek ${stepLabel}] ${msg}`),
        outDir,
        false,
      );
    } finally {
      releaseOwnPage();
    }

    const json = parseJsonFromText(res);
    if (json?.status === "AGENT_QUERY" && json.to && json.question) {
      const targetRole = json.to;
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

      if (!targetPage) {
        onStatus(`[Architect] Invalid target agent: ${targetRole}`);
        attempt++;
        continue;
      }

      if (used >= ARCHITECT_QUESTION_LIMIT) {
        onStatus(`[Architect] Quota exhausted. Query blocked.`);
        attempt++;
        continue;
      }

      onStatus(`[Architect] Querying ${targetRole}: ${json.question}`);
      questionsUsed.set("architect", used + 1);

      const targetModel =
        targetRole === "coder_a" ||
        targetRole === "reviewer_a" ||
        targetRole === "architect"
          ? "DeepSeek"
          : "Qwen";

      const answerPrompt = `### AGENT-TO-AGENT INQUIRY
From: Architect
Context: ${json.context || "No extra context provided"}
Question: ${json.question}

Please provide a clear, technical answer. Output ONLY the answer text.`;

      const releaseTargetPage = await lockPage(
        targetPage,
        `architect inquiry to ${targetRole}`,
      );
      let answer = "";
      try {
        if (targetModel === "DeepSeek") {
          answer = await askDeepseek(
            targetPage,
            answerPrompt,
            "",
            "",
            (msg) => onStatus(`[${targetRole} REPLY] ${msg}`),
            outDir,
            false,
          );
        } else {
          answer = await askQwen(
            targetPage,
            answerPrompt,
            "",
            (msg) => onStatus(`[${targetRole} REPLY] ${msg}`),
            outDir,
            false,
          );
        }
      } finally {
        releaseTargetPage();
      }
      
      // Synthesis agents get answer in follow-up prompt
      onStatus(`[Architect] Received answer from ${targetRole}.`);
      attempt++;
      continue;
    }

    done = true;
  }

  try {
    fs.rmSync(synthDir, { recursive: true, force: true });
  } catch {}
  return res;
}
