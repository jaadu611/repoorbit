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
  page: Page | null,
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
  const displayName = `${role} ${agentRole.startsWith("coder") ? "Coder" : agentRole.startsWith("reviewer") ? "Reviewer" : "Synthesizer"}`;
  let done = false;
  let attempt = 0;
  let raw = "";
  const uploadedHashes = new Map<string, string>();

  while (!done) {
    let effectiveUploadDir: string | null = null;

    const newFiles: { src: string; dstName: string }[] = [];
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
      if (fs.existsSync(investDir)) {
        for (const f of fs.readdirSync(investDir)) {
          const src = path.join(investDir, f);
          if (!fs.statSync(src).isFile()) continue;

          // ONLY upload actual context files (extra_*) or agent-to-agent replies (a2a_reply_*)
          // Do NOT upload subturn_*.txt or context_request_*.txt as they are already in the chat history.
          if (!f.startsWith("extra_") && !f.startsWith("a2a_reply_")) continue;

          // Check if we already uploaded this exact file content
          const hash = fileFingerprint(src);
          if (uploadedHashes.get(f) === hash) continue;

          newFiles.push({ src, dstName: f });
          uploadedHashes.set(f, hash);
        }
      }
      if (newFiles.length > 0) {
        fs.mkdirSync(extraTurnDir, { recursive: true });
        for (const item of newFiles) {
          fs.copyFileSync(item.src, path.join(extraTurnDir, item.dstName));
        }
        effectiveUploadDir = extraTurnDir;
      }
    }

    const newFilesList = newFiles.map((nf) => nf.dstName).join(", ");
    const turnPrompt =
      attempt === 0
        ? promptGenerator(0)
        : `[SYSTEM]: I have successfully uploaded the requested context files: ${newFilesList || "None"}.
Please proceed with your analysis and implementation. If you still need more files, use the NEED_MORE_CONTEXT protocol again. If you are ready to provide the fix, do so now.`;

    if (attempt > 0) {
      onStatus(
        `${displayName} — Sub-turn ${attempt}: Uploading ${newFiles.length} context files...`,
      );
      for (const nf of newFiles) {
        console.log(
          `[ORCHESTRATOR] ${displayName} turn ${attempt}: Uploading ${nf.dstName}`,
        );
      }
    } else {
      onStatus(`${displayName} — Starting main turn...`);
    }

    try {
      const releaseOwnPage = (role === "Qwen" && page) ? await lockPage(page, `${role} main turn`) : () => {};
      try {
        if (role === "DeepSeek") {
          raw = await askDeepseek(
            null, // Page not needed for API
            turnPrompt,
            manifestContent,
            effectiveUploadDir || "",
            (msg) => onStatus(`${displayName} — ${msg}`),
            outDir,
            attempt === 0,
            `[${displayName}]`,
          );
        } else if (role === "Qwen" && page) {
          raw = await askQwen(
            page,
            turnPrompt,
            effectiveUploadDir || "",
            (msg) => onStatus(`${displayName} — ${msg}`),
            outDir,
            attempt === 0,
            `[${displayName}]`,
          );
        }
      } finally {
        releaseOwnPage();
      }

      const json = parseJsonFromText(raw);

      // Save the raw output of THIS sub-turn for debugging/transparency
      const subTurnFileName = `subturn_${attempt}_raw.txt`;
      fs.writeFileSync(path.join(investDir, subTurnFileName), raw, "utf-8");

      if (json?.status === "AGENT_QUERY" && json.to && json.question) {
        const targetRole = json.to;
        // ... (existing targetPage logic) ...
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
          onStatus(`${displayName} — Quota exhausted. Question blocked.`);
          attempt++;
          continue;
        }

        onStatus(
          `${displayName} — Querying ${targetRole.startsWith("coder") ? "Researcher" : targetRole.startsWith("reviewer") ? "Reviewer" : "Synthesizer"}: ${json.question}`,
        );
        questionsUsed.set(agentRole, used + 1);

        // Save the QUESTION
        const questionFileName = `a2a_query_${attempt}_to_${targetRole}.txt`;
        fs.writeFileSync(
          path.join(investDir, questionFileName),
          `QUESTION TO ${targetRole}:\n\nContext: ${json.context || "None"}\n\nQuestion: ${json.question}`,
          "utf-8",
        );

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

        const releaseTargetPage = (targetModel === "Qwen" && targetPage) ? await lockPage(
          targetPage,
          `${targetRole} inquiry`,
        ) : () => {};
        let answer = "";
        try {
          if (targetModel === "DeepSeek") {
            answer = await askDeepseek(
              null,
              answerPrompt,
              manifestContent,
              "",
              (msg) =>
                onStatus(
                  `${targetRole.startsWith("coder") ? "Researcher" : targetRole.startsWith("reviewer") ? "Reviewer" : "Synthesizer"} — ${msg}`,
                ),
              outDir,
              false,
            );
          } else if (targetModel === "Qwen" && targetPage) {
            answer = await askQwen(
              targetPage,
              answerPrompt,
              "",
              (msg) =>
                onStatus(
                  `${targetRole.startsWith("coder") ? "Researcher" : targetRole.startsWith("reviewer") ? "Reviewer" : "Synthesizer"} — ${msg}`,
                ),
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
        onStatus(
          `${displayName} — Requesting ${mFiles.length} files for context...`,
        );

        // Save the REQUEST
        const requestFileName = `context_request_${attempt}.txt`;
        fs.writeFileSync(
          path.join(investDir, requestFileName),
          JSON.stringify(json, null, 2),
          "utf-8",
        );

        const fetched = await fillMissingFiles(
          mFiles,
          displayName,
          investDir,
          owner,
          repo,
          branch,
          outDir,
          manifestContent,
          latestResponsePath,
        );
        onStatus(`${displayName} — Fetched ${fetched} new context files.`);
      } else {
        done = true;
      }
    } catch (err: any) {
      onStatus(
        `${displayName} — CRITICAL: Sub-turn ${attempt} failed: ${err.message}`,
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

  // Final cleanup: strip any JSON status blocks from the response
  // so they don't pollute the combined file.
  // We prioritize keeping things that look like code (e.g., have // or functions)
  let cleanResponse = raw.replace(/\{[\s\S]*?"status"[\s\S]*?\}/g, "").trim();

  // If the cleanup leaves us with nothing but the model was in a "NEED_MORE_CONTEXT" loop,
  // it means the model never actually produced code.
  if (!cleanResponse || cleanResponse.length < 10) {
    return "// [No code implementation produced by this agent]";
  }

  return cleanResponse;
}

export async function qwenCombine(
  promptGenerator: (questionsLeft: number) => string,
  filesToAttach: string[],
  stepLabel: string,
  outDir: string,
  onStatus: (msg: string) => void,
  questionsUsed: Map<string, number>,
  latestReview?: string,
): Promise<string> {
  const displayName = "Qwen Synthesizer";
  onStatus(`${displayName} — ${stepLabel}...`);
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

  while (!done) {
    const turnPrompt =
      attempt === 0
        ? promptGenerator(0) // Dummy value
        : "Here is the answer to your previous query. Please continue with the synthesis.";

    const releaseOwnPage = await lockPage(
      persistentPages.qwenSynthesizer!,
      `architect synthesis`,
    );
    try {
      res = await askQwen(
        persistentPages.qwenSynthesizer!,
        turnPrompt,
        synthDir,
        (msg) => onStatus(`${displayName} — ${stepLabel}: ${msg}`),
        outDir,
        false,
        `[${displayName}]`,
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
                  ? persistentPages.qwenSynthesizer
                  : null;

      if (!targetPage && targetModel === "Qwen") {
        onStatus(
          `${displayName} — Invalid target agent: ${targetRole.startsWith("coder") ? "Coder" : "Reviewer"}`,
        );
        attempt++;
        continue;
      }

      const used = questionsUsed.get("architect") || 0;
      if (used >= ARCHITECT_QUESTION_LIMIT) {
        onStatus(`${displayName} — Quota exhausted. Query blocked.`);
        attempt++;
        continue;
      }

      onStatus(
        `${displayName} — Querying ${targetRole.startsWith("coder") ? "Coder" : targetRole.startsWith("reviewer") ? "Reviewer" : "Synthesizer"}: ${json.question}`,
      );
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

      const releaseTargetPage = (targetModel === "Qwen" && targetPage) ? await lockPage(
        targetPage,
        `architect inquiry to ${targetRole}`,
      ) : () => {};
      let answer = "";
      try {
        if (targetModel === "DeepSeek") {
          answer = await askDeepseek(
            null,
            answerPrompt,
            "",
            "",
            (msg) =>
              onStatus(
                `${targetRole.startsWith("coder") ? "Researcher" : targetRole.startsWith("reviewer") ? "Reviewer" : "Synthesizer"} — ${msg}`,
              ),
            outDir,
            false,
          );
        } else if (targetModel === "Qwen" && targetPage) {
          answer = await askQwen(
            targetPage,
            answerPrompt,
            "",
            (msg) =>
              onStatus(
                `${targetRole.startsWith("coder") ? "Researcher" : targetRole.startsWith("reviewer") ? "Reviewer" : "Synthesizer"} — ${msg}`,
              ),
            outDir,
            false,
          );
        }
      } finally {
        releaseTargetPage();
      }

      // Synthesis agents get answer in follow-up prompt
      onStatus(
        `${displayName} — Received answer from ${targetRole.startsWith("coder") ? "Coder" : targetRole.startsWith("reviewer") ? "Reviewer" : "Synthesizer"}.`,
      );
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
