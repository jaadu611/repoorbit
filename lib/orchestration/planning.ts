import fs from "fs";
import path from "path";
import { Page, BrowserContext } from "playwright";
import { askDeepseek } from "@/lib/automation/deepseek";
import { askQwen } from "@/lib/automation/qwen";
import { askGemini } from "@/lib/automation/gemini";
import { getGeminiPlannerPrompt } from "@/lib/prompts";
import { fileFingerprint } from "./utils";
import { fetchFile } from "./github";

export async function runModelPlanner(
  modelName: string,
  page: Page,
  query: string,
  manifestContent: string,
  repoUrl: string,
  defaultBranch: string,
  plannerFiles: string[],
  outDir: string,
  onStatus: (msg: string) => void,
): Promise<any> {
  let attempts = 0;
  let history = getGeminiPlannerPrompt(query);

  const parts = repoUrl.split("/");
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];

  let currentFiles = [...plannerFiles];
  const uploadedHashes = new Map<string, string>();

  const modelContextDir = path.join(
    outDir,
    `planner_context_${modelName.toLowerCase()}`,
  );
  if (!fs.existsSync(modelContextDir))
    fs.mkdirSync(modelContextDir, { recursive: true });

  while (attempts < 3) {
    const newFilesToUpload: string[] = [];
    for (const f of currentFiles) {
      if (!fs.existsSync(f)) continue;
      const name = path.basename(f);
      const hash = fileFingerprint(f);
      if (uploadedHashes.get(name) !== hash) {
        newFilesToUpload.push(f);
        uploadedHashes.set(name, hash);
      }
    }

    let turnUploadDir: string | null = null;
    if (newFilesToUpload.length > 0) {
      const turnDir = path.join(
        outDir,
        `upload_${modelName.toLowerCase()}_plan_${attempts}_${Date.now()}`,
      );
      fs.mkdirSync(turnDir, { recursive: true });
      for (const f of newFilesToUpload) {
        fs.copyFileSync(f, path.join(turnDir, path.basename(f)));
      }
      turnUploadDir = turnDir;
    }

    let response = "";
    try {
      if (modelName === "Gemini") {
        response = await askGemini(page, history, newFilesToUpload, (msg) =>
          onStatus(`[Gemini Planner] ${msg}`),
        );
      } else if (modelName === "DeepSeek") {
        response = await askDeepseek(
          page,
          history,
          manifestContent,
          turnUploadDir || "",
          (msg) => onStatus(`[DeepSeek Planner] ${msg}`),
          outDir,
          attempts === 0,
        );
      } else if (modelName === "Qwen") {
        response = await askQwen(
          page,
          history,
          turnUploadDir || "",
          (msg) => onStatus(`[Qwen Planner] ${msg}`),
          outDir,
          attempts === 0,
        );
      }
    } finally {
      if (turnUploadDir && fs.existsSync(turnUploadDir)) {
        try {
          fs.rmSync(turnUploadDir, { recursive: true, force: true });
        } catch {}
      }
    }

    let plan: any;
    try {
      const cleaned = response.replace(/```json|```/g, "").trim();
      const s = cleaned.indexOf("{");
      const e = cleaned.lastIndexOf("}");
      if (s === -1) throw new Error("No JSON object found");
      plan = JSON.parse(cleaned.slice(s, e + 1));
      return { status: "FAILED", raw: response };
    }

    if (plan.status === "READY" || plan.status === "GENERIC") return plan;

    if (plan.status === "NEED_FILE" && Array.isArray(plan.files)) {
      onStatus(`[${modelName} Planner] Fetching requested files...`);
      let fetchedCount = 0;
      for (const f of plan.files.slice(0, 5)) {
        const content = await fetchFile(
          outDir,
          owner,
          repo,
          defaultBranch,
          f.path,
        );
        if (content) {
          const safeName = f.path.replace(/[^a-zA-Z0-9_-]/g, "_");
          const extraPath = path.join(modelContextDir, `extra_${safeName}.txt`);
          fs.writeFileSync(extraPath, content, "utf-8");
          currentFiles.push(extraPath);
          fetchedCount++;
        }
      }

      if (fetchedCount === 0) {
        history +=
          "\n\n" +
          response +
          "\n\n[System: None of the requested files could be found. Please proceed with the information you have.]";
      } else {
        history +=
          "\n\n" +
          response +
          "\n\n[System: I have uploaded the requested context files. Please continue your analysis.]";
      }

      attempts++;
      continue;
    }

    return plan;
  }

  return { status: "FAILED" };
}

export async function runDualPlanner(
  context: BrowserContext,
  query: string,
  manifestContent: string,
  repoUrl: string,
  defaultBranch: string,
  plannerFiles: string[],
  outDir: string,
  onStatus: (msg: string) => void,
): Promise<any> {
  const [deepPage, qwenPage] = await Promise.all([
    context.newPage(),
    context.newPage(),
  ]);

  onStatus("Dual-model planning initiated (DeepSeek + Qwen)...");

  const [dPlan, qPlan] = await Promise.all([
    runModelPlanner(
      "DeepSeek",
      deepPage,
      query,
      manifestContent,
      repoUrl,
      defaultBranch,
      plannerFiles,
      outDir,
      onStatus,
    ),
    runModelPlanner(
      "Qwen",
      qwenPage,
      query,
      manifestContent,
      repoUrl,
      defaultBranch,
      plannerFiles,
      outDir,
      onStatus,
    ),
  ]);

  await Promise.allSettled([deepPage.close(), qwenPage.close()]);

  if (dPlan.status === "FAILED" && qPlan.status === "FAILED")
    return { status: "FAILED" };

  const plans = [dPlan, qPlan];
  const genericVotes = plans.filter((p) => p.status === "GENERIC").length;
  const readyVotes = plans.filter((p) => p.status === "READY").length;

  if (genericVotes > 0 && genericVotes >= readyVotes) {
    const genericReason = plans.find((p) => p.status === "GENERIC")?.reason;
    onStatus(
      `Generic question confirmed (${genericVotes}G vs ${readyVotes}R). Synthesizing notebook queries...`,
    );

    const allGenericNotebooks = plans
      .filter((p) => Array.isArray(p.notebooks))
      .flatMap((p) => p.notebooks as any[]);

    if (allGenericNotebooks.length === 0)
      return { status: "GENERIC", reason: genericReason, notebooks: [] };

    const geminiPage =
      context.pages().find((p) => p.url().includes("gemini.google.com")) ||
      (await context.newPage());

    const genericSynthPrompt = `You are merging notebook investigation queries for a high-level codebase question.
Merge and deduplicate the following notebook sub-questions into a final list.
Each notebook must appear ONLY ONCE with a single comprehensive, merged sub-question.

### INPUT (from multiple planner agents):
${JSON.stringify(allGenericNotebooks, null, 2)}

Return ONLY valid JSON:
{"status": "GENERIC", "notebooks": [{"name": "notebook_name", "sub_question": "merged question"}]}
No explanation. No markdown.`;

    const genericSynthResponse = await askGemini(
      geminiPage,
      genericSynthPrompt,
      [],
      (msg) => onStatus(`[Generic Synthesis] ${msg}`),
    );
    try {
      const cleaned = genericSynthResponse.replace(/```json|```/g, "").trim();
      const s = cleaned.indexOf("{");
      const e = cleaned.lastIndexOf("}");
      const parsed = JSON.parse(cleaned.slice(s, e + 1));
      return {
        status: "GENERIC",
        reason: genericReason,
        notebooks: parsed.notebooks || [],
      };
    } catch {
      return {
        status: "GENERIC",
        reason: genericReason,
        notebooks: allGenericNotebooks,
      };
    }
  }

  const readyPlans: Record<string, any> = {};
  if (dPlan.status === "READY") readyPlans["DEEPSEEK"] = dPlan;
  if (qPlan.status === "READY") readyPlans["QWEN"] = qPlan;

  const readyEntries = Object.entries(readyPlans);
  if (readyEntries.length === 1) {
    onStatus(`Using ${readyEntries[0][0]}'s plan directly (only 1 READY).`);
    return readyEntries[0][1];
  }

  const geminiPage =
    context.pages().find((p) => p.url().includes("gemini.google.com")) ||
    (await context.newPage());

  const planEntries = readyEntries
    .map(([name, plan]) => `${name}: ${JSON.stringify(plan)}`)
    .join("\n");
  onStatus(
    `Synthesizing unified plan with Gemini (${readyEntries.length}/2 READY plans)...`,
  );

  const synthPrompt = `Synthesize these investigation plans into a SINGLE, EXHAUSTIVE, and COMPREHENSIVE master plan.

PRIORITY: MAXIMIZE COVERAGE
1. Include every notebook any agent identified.
2. Merge duplicates — each notebook name appears ONLY ONCE with a merged sub-question.
3. Return ONLY valid JSON: {"status": "READY", "notebooks": [...]}

### DRAFT PLANS:
${planEntries}

Return ONLY JSON. No explanation. No markdown.`;

  const synthResponse = await askGemini(geminiPage, synthPrompt, [], (msg) =>
    onStatus(`[Synthesis] ${msg}`),
  );
  try {
    const cleaned = synthResponse.replace(/```json|```/g, "").trim();
    const s = cleaned.indexOf("{");
    const e = cleaned.lastIndexOf("}");
    return JSON.parse(cleaned.slice(s, e + 1));
  } catch {
    return dPlan.status === "READY"
      ? dPlan
      : qPlan.status === "READY"
        ? qPlan
        : { status: "FAILED" };
  }
}
