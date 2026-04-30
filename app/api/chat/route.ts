import { buildMasterContext } from "@/lib/contextBuilder";
import { buildDeepseekContext } from "@/lib/deepseekContextBuilder";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { analyzeFile } from "@/lib/github";
import {
  automateNotebookLM,
  automateSubQuestion,
} from "@/lib/notebooklmAutomator";
import { automateChatGPT } from "@/lib/chatgptAutomator";
import { getOrCreateContext } from "@/lib/browser";
import { askDeepseek } from "@/lib/deepseekAutomator";
import { askQwen } from "@/lib/qwenAutomator";
import { askGemini } from "@/lib/geminiAutomator";

import {
  getDeepseekCodingPrompt,
  getGeminiSynthesisPrompt,
  getGeminiPlannerPrompt,
  getNotebookSubQuestionPrompt,
  getNotebookSystemInstruction,
  getGenericNotebookPrompt,
  getCodeReviewPrompt,
  getReviewSynthesisPrompt,
  getCoderRefinementPrompt,
} from "@/lib/prompts";
import { NextResponse } from "next/server";
import { Page, BrowserContext } from "playwright";
import { JobStatus } from "@/lib/types";

export const CONTEXT_DIR_PATH = "/tmp/notebooklm_sources";

const GLOBAL_JOBS_KEY = Symbol.for("repoorbit.playwright.jobs");
export const activeJobs: Map<string, JobStatus> =
  (global as any)[GLOBAL_JOBS_KEY] || new Map();
(global as any)[GLOBAL_JOBS_KEY] = activeJobs;

// ─── Constants & Helpers ──────────────────────────────────────────────────────

const MAX_LINES_PER_FILE = 500;
const MAX_FILES_PER_TURN = 5;

/**
 * Persistent chat page handles for the 4 roles.
 * Stored globally so they survive across hot-reloads in dev.
 */
const GLOBAL_PAGES_KEY = Symbol.for("repoorbit.playwright.pages");
interface PersistentPages {
  dsCoder: Page | null;
  qwenCoder: Page | null;
  dsReviewer: Page | null;
  qwenReviewer: Page | null;
  dsSynthesizer: Page | null;
}
const persistentPages: PersistentPages = (global as any)[GLOBAL_PAGES_KEY] || {
  dsCoder: null,
  qwenCoder: null,
  dsReviewer: null,
  qwenReviewer: null,
  dsSynthesizer: null,
};
(global as any)[GLOBAL_PAGES_KEY] = persistentPages;

// ─── fetchFile ────────────────────────────────────────────────────────────────

async function fetchFile(
  outDir: string,
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  lineRange?: [number, number],
): Promise<string | null> {
  const safeBranch = branch && branch.trim() ? branch.trim() : "main";
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${safeBranch}/${filePath}`;
  console.log(`[GITHUB] Fetching: ${url}`);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[GITHUB] 404/Error: ${url} (Status: ${res.status})`);
      return null;
    }
    const text = await res.text();
    const lines = text.split("\n");

    console.log(
      `[GITHUB] Success: ${filePath} (${lines.length} lines). Preview: ${lines[0].substring(0, 50)}...`,
    );

    if (lineRange) {
      const startIdx = lineRange[0] > 0 ? lineRange[0] - 1 : 0;
      const endIdx =
        lineRange[1] > 0
          ? Math.min(lines.length - 1, lineRange[1] - 1)
          : lines.length - 1;
      const slice = lines.slice(startIdx, endIdx + 1);
      const MAX_RANGE_LIMIT = 1500;
      if (slice.length > MAX_RANGE_LIMIT) {
        return (
          slice.slice(0, MAX_RANGE_LIMIT).join("\n") +
          `\n\n// [TRUNCATED] Only first ${MAX_RANGE_LIMIT} lines of the requested range are shown.`
        );
      }
      return slice.join("\n");
    }

    if (lines.length > MAX_LINES_PER_FILE) {
      return (
        lines.slice(0, MAX_LINES_PER_FILE).join("\n") +
        `\n\n// [TRUNCATED] Only first ${MAX_LINES_PER_FILE} lines shown. Use "line_range": [start, end] to request more.`
      );
    }
    return text;
  } catch (err: any) {
    console.error(`[GITHUB] Error fetching ${url}:`, err.message);
    return `// Error fetching ${filePath}`;
  }
}

// ─── fillMissingFiles ─────────────────────────────────────────────────────────

async function fillMissingFiles(
  missingFiles: any[],
  filledSet: Set<string>,
  modelName: string,
  modelInvestDir: string,
  owner: string,
  repo: string,
  branch: string,
  outDir: string,
  latestResponsePath?: string,
): Promise<number> {
  const filesToFetch = missingFiles.slice(0, MAX_FILES_PER_TURN);
  let count = 0;

  for (const f of filesToFetch) {
    const filePath = f.path || f.file_path;
    if (!filePath) continue;

    const lowerPath = filePath.toLowerCase();
    
    // Special handling for the latest combined response
    if (lowerPath === "combined_response.txt" && latestResponsePath && fs.existsSync(latestResponsePath)) {
      console.log(`[ORCHESTRATOR] ${modelName} requesting latest combined response...`);
      const dst = path.join(modelInvestDir, "combined_response.txt");
      fs.copyFileSync(latestResponsePath, dst);
      count++;
      continue;
    }

    if (
      lowerPath.includes("combined_") ||
      lowerPath.includes("review_") ||
      lowerPath.includes("symbols.") ||
      lowerPath.includes("manifest") ||
      lowerPath.includes("context.js") ||
      lowerPath.includes("meta.txt")
    ) {
      console.warn(
        `[ORCHESTRATOR] Blocking internal file request: ${filePath}`,
      );
      continue;
    }

    const lineRange = Array.isArray(f.line_range) ? f.line_range : undefined;
    const key = `${filePath}|${lineRange?.join(",") || ""}`.toLowerCase();
    if (filledSet.has(key)) continue;
    filledSet.add(key);

    console.log(
      `[ORCHESTRATOR] ${modelName} requesting: ${filePath}${lineRange ? ` lines ${lineRange.join("-")}` : ""}`,
    );

    // LOCAL FULFILLMENT
    const localPaths = [
      path.join(outDir, filePath),
      path.join(modelInvestDir, filePath),
      path.join(path.dirname(outDir), filePath),
    ];
    let localContent: string | null = null;
    for (const p of localPaths) {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        localContent = fs.readFileSync(p, "utf-8");
        break;
      }
    }

    if (localContent) {
      const safeName = filePath.replace(/[^a-zA-Z0-9_-]/g, "_");
      const extraFileName = `extra_${count.toString().padStart(2, "0")}_${safeName}.txt`;
      fs.writeFileSync(
        path.join(modelInvestDir, extraFileName),
        localContent,
        "utf-8",
      );
      console.log(
        `[ORCHESTRATOR] ${modelName}: Local fulfillment for ${filePath}`,
      );
      count++;
      continue;
    }

    // SYMBOL REQUEST
    if (f.name_hint || f.name) {
      const symbolPathB = {
        intent: `Missing symbol: ${f.name_hint || f.name}`,
        target_symbols: [
          {
            name: f.name_hint || f.name,
            source_file: filePath,
            role: f.role,
            type: f.type,
          },
        ],
      };
      const tempOutDir = path.join(modelInvestDir, `temp_${count}`);
      fs.mkdirSync(tempOutDir, { recursive: true });
      ["graph.json", "notebooks.json", "package.json"].forEach(
        (file) => {
          const src = path.join(outDir, file);
          if (fs.existsSync(src))
            fs.copyFileSync(src, path.join(tempOutDir, file));
        },
      );

      buildDeepseekContext(symbolPathB, tempOutDir);

      const nestedDir = path.join(tempOutDir, "deepseek_context");
      if (fs.existsSync(nestedDir)) {
        for (const file of fs.readdirSync(nestedDir)) {
          const src = path.join(nestedDir, file);
          const dst = path.join(modelInvestDir, `extra_${count}_${file}`);
          fs.copyFileSync(src, dst);
        }
      }
      fs.rmSync(tempOutDir, { recursive: true, force: true });
      count++;
      continue;
    }

    const content = await fetchFile(
      outDir,
      owner,
      repo,
      branch,
      filePath,
      lineRange as [number, number],
    );
    if (content === null) {
      console.warn(
        `[ORCHESTRATOR] ${modelName}: Skipping ${filePath} (not found).`,
      );
      continue;
    }

    const safeName = filePath.replace(/[^a-zA-Z0-9_-]/g, "_");
    const extraFileName = `extra_${count.toString().padStart(2, "0")}_${safeName}.txt`;
    const extraFilePath = path.join(modelInvestDir, extraFileName);
    fs.mkdirSync(modelInvestDir, { recursive: true });
    fs.writeFileSync(extraFilePath, content, "utf-8");
    console.log(
      `[ORCHESTRATOR] ${modelName}: Saved extra context → ${extraFileName}`,
    );
    count++;
  }

  console.log(
    `[ORCHESTRATOR] ${modelName}: Extra files fetched this turn: ${count}`,
  );
  return count;
}

// ─── fileFingerprint / prepareTurnDir ────────────────────────────────────────

function fileFingerprint(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return `${content.length}:${content.slice(0, 64)}`;
  } catch {
    return `missing:${filePath}`;
  }
}

/**
 * Assembles a temporary upload dir for a single model turn.
 *
 * @param outDir         - repo working dir
 * @param modelPrefix    - "deepseek" | "qwen" etc.
 * @param attempt        - turn index (0-based)
 * @param baseContextDir - deepseek_context dir (base context uploaded on attempt 0 ONLY for coders)
 * @param investDir      - per-model extra-files staging dir
 * @param seenHashes     - dedup map (mutated in-place)
 * @param includeBase    - whether to include base context files (only first coder turn)
 * @param extraFiles     - explicit additional files to include this turn (e.g. combined_review)
 */
function prepareTurnDir(
  outDir: string,
  modelPrefix: string,
  attempt: number,
  baseContextDir: string,
  investDir: string,
  seenHashes: Map<string, string>,
  includeBase: boolean,
  extraFiles: string[] = [],
): string | null {
  const turnDir = path.join(
    outDir,
    `${modelPrefix}_upload_${attempt}_${Date.now()}`,
  );
  const filesToCopy: { src: string; dstName: string }[] = [];

  // 1. Base context — only when explicitly requested (first coder turn)
  if (includeBase && fs.existsSync(baseContextDir)) {
    for (const f of fs.readdirSync(baseContextDir)) {
      if (f === "gap_filler.txt") continue;
      filesToCopy.push({ src: path.join(baseContextDir, f), dstName: f });
    }
  }

  // 2. Explicit extra files for this turn (e.g. combined_review_N.txt)
  for (const src of extraFiles) {
    if (!fs.existsSync(src)) continue;
    const dstName = path.basename(src);
    filesToCopy.push({ src, dstName });
  }

  // 3. Any new files in the investigation dir (NEED_MORE_CONTEXT fulfillment)
  if (fs.existsSync(investDir)) {
    for (const f of fs.readdirSync(investDir)) {
      const src = path.join(investDir, f);
      if (!fs.statSync(src).isFile()) continue;
      const fingerprint = fileFingerprint(src);
      if (seenHashes.get(f) === fingerprint) continue;
      filesToCopy.push({ src, dstName: f });
    }
  }

  if (filesToCopy.length === 0) return null;

  if (fs.existsSync(turnDir))
    fs.rmSync(turnDir, { recursive: true, force: true });
  fs.mkdirSync(turnDir, { recursive: true });

  for (const item of filesToCopy) {
    const dst = path.join(turnDir, item.dstName);
    fs.copyFileSync(item.src, dst);
    seenHashes.set(item.dstName, fileFingerprint(item.src));
  }

  console.log(
    `[ORCHESTRATOR] ${modelPrefix} turn ${attempt}: ${filesToCopy.length} files in upload dir`,
  );
  return turnDir;
}

// ─── runModelPlanner ──────────────────────────────────────────────────────────

async function runModelPlanner(
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

  // Staging dir for extra files
  const modelContextDir = path.join(
    outDir,
    `planner_context_${modelName.toLowerCase()}`,
  );
  if (!fs.existsSync(modelContextDir))
    fs.mkdirSync(modelContextDir, { recursive: true });

  while (attempts < 3) {
    // 1. Identify and stage new files for this turn
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
        response = await askGemini(
          page,
          history,
          newFilesToUpload,
          (msg) => onStatus(`[Gemini Planner] ${msg}`),
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
      // Clean up the turn-specific upload dir
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
    } catch (parseErr: any) {
      console.warn(
        `[${modelName} Planner] JSON parse FAILED (attempt ${attempts}): ${parseErr.message}`,
      );
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

    console.warn(
      `[${modelName} Planner] Unhandled plan status "${plan.status}".`,
    );
    return plan;
  }

  console.warn(`[${modelName} Planner] Exhausted all attempts.`);
  return { status: "FAILED" };
}

// ─── runDualPlanner ───────────────────────────────────────────────────────────

async function runDualPlanner(
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

  console.log(
    `[Dual Planner] DeepSeek: ${dPlan.status}, Qwen: ${qPlan.status}`,
  );
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

// ─── collectRelevantFiles ─────────────────────────────────────────────────────

async function collectRelevantFiles(
  page: Page,
  query: string,
  notebookPlans: any[],
  outDir: string,
): Promise<string[]> {
  const allFiles = new Set<string>();
  const notebooksPath = path.join(outDir, "notebooks.json");
  let notebooks: any[] = [];
  if (fs.existsSync(notebooksPath)) {
    try {
      notebooks = JSON.parse(fs.readFileSync(notebooksPath, "utf-8"));
    } catch {}
  }

  for (const plan of notebookPlans) {
    const nb = notebooks.find(
      (n) => n.name === plan.name || n.title === plan.name,
    );
    if (!nb) {
      console.warn(`[NotebookLM] Unknown notebook: ${plan.name}`);
      continue;
    }
    console.log(
      `[ORCHESTRATOR] Querying NotebookLM: "${nb.title}" (${nb.localFiles?.length || 0} files)`,
    );
    const files = await automateSubQuestion(
      page,
      nb.title,
      getNotebookSubQuestionPrompt(plan.sub_question),
      nb.localFiles,
    );
    if (Array.isArray(files)) {
      files.forEach((f) => {
        if (f !== "notebook_instructions.txt" && f !== "00_manifest.txt")
          allFiles.add(f);
      });
    }
  }

  console.log(
    `[ORCHESTRATOR] Total context files from NotebookLM: ${allFiles.size}`,
  );
  return Array.from(allFiles);
}

// ─── collectGenericAnswers ────────────────────────────────────────────────────

async function collectGenericAnswers(
  page: Page,
  notebookPlans: any[],
  outDir: string,
  onStatus: (msg: string) => void,
): Promise<{ sub_question: string; answer: string; notebook: string }[]> {
  const answers: { sub_question: string; answer: string; notebook: string }[] =
    [];
  const notebooksPath = path.join(outDir, "notebooks.json");
  let notebooks: any[] = [];
  if (fs.existsSync(notebooksPath)) {
    try {
      notebooks = JSON.parse(fs.readFileSync(notebooksPath, "utf-8"));
    } catch {}
  }

  for (const plan of notebookPlans) {
    const nb = notebooks.find(
      (n) => n.name === plan.name || n.title === plan.name,
    );
    if (!nb) {
      console.warn(`[Generic] Unknown notebook: ${plan.name}`);
      continue;
    }
    onStatus(`Querying notebook "${nb.title}" for deep context...`);
    try {
      const answer = await automateNotebookLM(
        page,
        nb.localFiles || [],
        getGenericNotebookPrompt(plan.sub_question),
        nb.title,
        (msg) => onStatus(`[NotebookLM] ${msg}`),
        false,
      );
      answers.push({
        sub_question: plan.sub_question,
        answer,
        notebook: nb.title,
      });
    } catch (err: any) {
      answers.push({
        sub_question: plan.sub_question,
        answer: `[Error: ${err.message}]`,
        notebook: nb.title,
      });
    }
  }
  return answers;
}

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const taskId = searchParams.get("taskId");
  if (!taskId)
    return NextResponse.json({ error: "Missing taskId" }, { status: 400 });
  return NextResponse.json(activeJobs.get(taskId) || { status: "pending" });
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    const { query, owner, repo, defaultBranch } = await req.json();
    const taskId = Math.random().toString(36).substring(7);
    activeJobs.set(taskId, { status: "pending" });

    const outDir = path.join(CONTEXT_DIR_PATH, owner, repo);
    const insightsPath = path.join(outDir, "phase2_insights.txt");
    const queryPromptPath = path.join(outDir, "QUERY_PROMPT.txt");
    [insightsPath, queryPromptPath].forEach((f) => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });

    const processJob = async () => {
      const manifestPath = path.join(outDir, "00_Root_Manifest.txt");

      try {
        const setStatus = (
          msg: string,
          partial?: string,
          overrideProgress?: number,
        ) => {
          const job = activeJobs.get(taskId);
          if (job)
            activeJobs.set(taskId, {
              ...job,
              statusText: msg,
              partialResult: partial,
              progress: overrideProgress,
            });
        };

        // ── Step 1: Clone repo and build notebooks (only on first run) ────────
        if (!fs.existsSync(outDir)) {
          fs.mkdirSync(outDir, { recursive: true });
          const tmpRepoDir = path.join(outDir, `tmp_clone_${Date.now()}`);
          setStatus("Cloning repository...");
          try {
            execSync(
              `git clone --depth=1 https://github.com/${owner}/${repo}.git ${tmpRepoDir}`,
              { stdio: "pipe" },
            );
          } catch (cloneErr: any) {
            activeJobs.set(taskId, {
              status: "error",
              error: `git clone failed: ${cloneErr.message}`,
            });
            return;
          }

          setStatus("Gathering repository metadata...");
          const ignoredExtensions = [
            ".png",
            ".jpg",
            ".jpeg",
            ".gif",
            ".ico",
            ".svg",
            ".bmp",
            ".webp",
            ".mp4",
            ".mp3",
            ".wav",
            ".zip",
            ".tar",
            ".gz",
            ".pdf",
            ".ttf",
            ".woff",
            ".woff2",
            ".lock",
            ".log",
            ".DS_Store",
            ".eslintcache",
            ".sketch",
          ];
          const ignoredNames = [
            "package-lock.json",
            "yarn.lock",
            "pnpm-lock.yaml",
            "composer.lock",
            "Cargo.lock",
            "poetry.lock",
            "Gemfile.lock",
            ".gitignore",
            ".gitattributes",
          ];
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
                if ([".git", "node_modules", "vendor"].includes(entry))
                  continue;
                walkRepo(fullPath);
                continue;
              }
              const relPath = path.relative(tmpRepoDir, fullPath);
              const pLower = relPath.toLowerCase();
              if (ignoredExtensions.some((ext) => pLower.endsWith(ext)))
                continue;
              if (ignoredNames.some((name) => pLower.endsWith(name))) continue;
              if (stat.size > 500000) continue;
              try {
                const content = fs.readFileSync(fullPath, "utf-8");
                filesMetadata.push({
                  path: relPath,
                  content,
                  size: stat.size,
                  name: entry,
                  type: "file",
                  ext: entry.split(".").pop() || "",
                });
              } catch {
                continue;
              }
            }
          };
          walkRepo(tmpRepoDir);
          console.log(`[CLONE] Collected ${filesMetadata.length} files`);

          setStatus("Building master context...");
          const miniRepoContext = {
            meta: { fullName: `${owner}/${repo}`, owner, name: repo },
            stats: { extFrequency: {} },
          };
          const fileSet = new Set<string>(filesMetadata.map((f) => f.path));
          const importGraph: any = {};
          for (const f of filesMetadata) {
            const analysis = analyzeFile(f.path, f.content, fileSet);
            importGraph[f.path] = {
              imports: analysis.imports,
              imported_by: [],
            };
          }
          await buildMasterContext(
            outDir,
            filesMetadata,
            importGraph,
            miniRepoContext,
            query,
            undefined,
            true,
          );
          fs.rmSync(tmpRepoDir, { recursive: true, force: true });
          setStatus("Context built. Starting planning...");
        }

        // ── Step 2: Open 4 persistent chat pages ─────────────────────────────
        const context = await getOrCreateContext();

        if (!persistentPages.dsCoder || persistentPages.dsCoder.isClosed())
          persistentPages.dsCoder = await context.newPage();
        if (!persistentPages.qwenCoder || persistentPages.qwenCoder.isClosed())
          persistentPages.qwenCoder = await context.newPage();
        if (
          !persistentPages.dsReviewer ||
          persistentPages.dsReviewer.isClosed()
        )
          persistentPages.dsReviewer = await context.newPage();
        if (
          !persistentPages.qwenReviewer ||
          persistentPages.qwenReviewer.isClosed()
        )
          persistentPages.qwenReviewer = await context.newPage();
        if (
          !persistentPages.dsSynthesizer ||
          persistentPages.dsSynthesizer.isClosed()
        )
          persistentPages.dsSynthesizer = await context.newPage();

        console.log("[ORCHESTRATOR] 4 persistent chat pages ready.");

        // ── Step 3: Dual-model planning ───────────────────────────────────────
        const repoUrl = `https://github.com/${owner}/${repo}`;
        const rootManifestContent = fs.readFileSync(manifestPath, "utf-8");
        const readmePath = path.join(outDir, "README.md");
        const notebooksPath = path.join(outDir, "notebooks.json");
        const plannerFiles = [manifestPath];
        if (fs.existsSync(readmePath)) plannerFiles.push(readmePath);
        if (fs.existsSync(notebooksPath)) plannerFiles.push(notebooksPath);

        const plan = await runDualPlanner(
          context,
          query,
          rootManifestContent,
          repoUrl,
          defaultBranch,
          plannerFiles,
          outDir,
          (msg) => setStatus(msg),
        );

        // ── GENERIC question path ─────────────────────────────────────────────
        if (plan.status === "GENERIC") {
          setStatus(
            "Generic question: querying notebooks for deep codebase analysis...",
          );
          let notebookPage = context
            .pages()
            .find((p: any) => p.url()?.includes("notebooklm.google.com"));
          if (!notebookPage) notebookPage = await context.newPage();

          const genericAnswers = await collectGenericAnswers(
            notebookPage,
            plan.notebooks || [],
            outDir,
            (msg) => setStatus(msg),
          );

          const answersBlock =
            genericAnswers.length > 0
              ? genericAnswers
                  .map(
                    (a, i) =>
                      `### Analysis ${i + 1} — ${a.notebook}\n**Sub-Question:** ${a.sub_question}\n\n${a.answer}`,
                  )
                  .join("\n\n---\n\n")
              : "(No notebook analysis available — answering from general knowledge)";

          const chatGPTPrompt = `You are a Staff Systems Engineer synthesizing a comprehensive answer about a codebase.

### MAIN QUESTION
${query}

### DEEP CODEBASE ANALYSIS
${answersBlock}

---
Synthesize all the insights above into a single, cohesive, well-structured response to the main question.`;

          setStatus("Synthesizing final answer with ChatGPT...");
          const chatPage =
            context.pages().find((p) => p.url().includes("chatgpt.com")) ||
            (await context.newPage());
          const genericResult = await automateChatGPT(
            chatPage,
            chatGPTPrompt,
            (msg) => setStatus(`[ChatGPT] ${msg}`),
          );
          activeJobs.set(taskId, {
            status: "done",
            result: genericResult,
            answerSource: "final",
          });
          return;
        }

        if (plan.status === "FAILED") {
          activeJobs.set(taskId, {
            status: "error",
            error: "Planner failed to generate a valid investigation plan.",
          });
          return;
        }

        // ── Step 4: Collect relevant files via NotebookLM ─────────────────────
        setStatus("NotebookLM is gathering evidence...");
        let notebookPage = context
          .pages()
          .find((p: any) => p.url()?.includes("notebooklm.google.com"));
        if (!notebookPage) notebookPage = await context.newPage();
        const contextFiles = await collectRelevantFiles(
          notebookPage,
          query,
          plan.notebooks || [],
          outDir,
        );

        // ── Step 5: Build precise code context ───────────────────────────────
        setStatus("Building precise code context...");
        const dsBaseContextDir = path.join(outDir, "deepseek_context");
        const initialPathBJson = {
          intent: query,
          context_files: contextFiles,
          target_symbols: [],
        };
        const contextResult = buildDeepseekContext(initialPathBJson, outDir);
        fs.writeFileSync(
          path.join(dsBaseContextDir, "context.js"),
          contextResult.contextText,
          "utf-8",
        );
        console.log(`[ORCHESTRATOR] Built base context in ${dsBaseContextDir}`);

        // ── Step 6: Run the coder–reviewer loop ───────────────────────────────
        setStatus("Starting coder–reviewer loop...");
        const finalAnswer = await runCoderReviewerLoop(
          query,
          owner,
          repo,
          defaultBranch,
          outDir,
          dsBaseContextDir,
          rootManifestContent,
          context,
          (msg) => setStatus(msg),
        );

        activeJobs.set(taskId, {
          status: "done",
          result: finalAnswer,
          answerSource: "reviewed",
        });
      } catch (err: any) {
        console.error("[PROCESS-JOB] Error:", err);
        activeJobs.set(taskId, { status: "error", error: err.message });
      }
    };

    processJob().catch((err) => console.error("[PROCESS-JOB] Fatal:", err));
    return NextResponse.json({ status: "accepted", taskId });
  } catch (error: any) {
    console.error("[API-CHAT] Uncaught Route Error:", error);
    return NextResponse.json(
      { error: error.message, status: "error", details: error.stack },
      { status: 500 },
    );
  }
}

// ─── runSingleModelTurn ───────────────────────────────────────────────────────
/**
 * Sends one message to a model page (DeepSeek or Qwen) and handles
 * NEED_MORE_CONTEXT loops internally, returning the final response string.
 *
 * @param role        - identifies which persistent page to use (dsCoder etc.)
 * @param page        - the persistent Playwright Page for this chat
 * @param prompt      - text prompt to send
 * @param uploadDir   - optional dir of files to upload with this message (null = no upload)
 * @param investDir   - staging dir for NEED_MORE_CONTEXT fulfillment
 * @param filledSet   - dedup set for extra-file fetches
 * @param outDir      - repo working dir
 * @param owner/repo/branch - for GitHub fetches
 * @param manifestContent - root manifest (passed to askDeepseek / askQwen)
 * @param onStatus    - status callback
 */
async function runSingleModelTurn(
  role: "DeepSeek" | "Qwen",
  page: Page,
  prompt: string,
  uploadDir: string | null,
  investDir: string,
  filledSet: Set<string>,
  outDir: string,
  owner: string,
  repo: string,
  branch: string,
  manifestContent: string,
  onStatus: (msg: string) => void,
  latestResponsePath?: string,
): Promise<string> {
  let done = false;
  let attempt = 0;
  let raw = "";
  // seenHashes is LOCAL to this turn invocation — upload dir is passed explicitly
  const uploadedHashes = new Map<string, string>();

  while (!done && attempt < 20) {
    // On the very first sub-turn use the provided uploadDir; subsequent sub-turns
    // only upload new extra files produced by NEED_MORE_CONTEXT fulfillment.
    let effectiveUploadDir: string | null = null;

    if (attempt === 0 && uploadDir) {
      effectiveUploadDir = uploadDir;
      // Mark all files in uploadDir as seen so they're not re-uploaded
      if (fs.existsSync(uploadDir)) {
        for (const f of fs.readdirSync(uploadDir)) {
          const src = path.join(uploadDir, f);
          if (fs.statSync(src).isFile())
            uploadedHashes.set(f, fileFingerprint(src));
        }
      }
    } else {
      // Build a dir of ONLY new extra files (if any)
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

    const turnPrompt =
      attempt === 0
        ? prompt
        : "Here are the additional context files you requested. Please continue.";

    onStatus(`[${role}] Sub-turn ${attempt}...`);

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
    } catch (err: any) {
      onStatus(
        `[${role}] CRITICAL: Sub-turn ${attempt} failed: ${err.message}`,
      );
      done = true;
      break;
    } finally {
      // Clean up ephemeral extra dirs (not the main uploadDir which caller manages)
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

    // Parse response to check for NEED_MORE_CONTEXT
    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const s = cleaned.indexOf("{");
      const e = cleaned.lastIndexOf("}");
      if (s !== -1 && e > s) {
        const data = JSON.parse(cleaned.slice(s, e + 1));
        if (data.status === "NEED_MORE_CONTEXT") {
          const mFiles = data.missing_files || data.missing_symbols || [];
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
      } else {
        done = true;
      }
    } catch {
      done = true;
    }

    attempt++;
  }

  return raw;
}

// ─── runCoderReviewerLoop ─────────────────────────────────────────────────────
/**
 * The main coder–reviewer iteration loop.
 *
 * Flow per iteration:
 *   1. Both coders run in parallel  → Gemini combines → combined_response_N.txt
 *   2. Both reviewers run in parallel → Gemini combines → combined_review_N.txt
 *   3. If HAS_ISSUES=NO  → return final Gemini synthesis
 *   4. If HAS_ISSUES=YES → feed combined_review_N.txt back to coders → go to 1
 *
 * Base context (context.js + manifest) is uploaded ONLY on the very first coder turn.
 * Reviewers receive combined_response_N.txt on their FIRST review turn (files already in chat thereafter).
 */
export async function runCoderReviewerLoop(
  query: string,
  owner: string,
  repo: string,
  defaultBranch: string,
  outDir: string,
  dsBaseContextDir: string,
  rootManifestContent: string,
  context: BrowserContext,
  onStatus: (msg: string) => void,
): Promise<string> {
  const MAX_ROUNDS = 10;

  // ── Investment dirs (for NEED_MORE_CONTEXT extra file staging) ────────────
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

  // ── Dedup sets per role ───────────────────────────────────────────────────
  const dsCoderFilled = new Set<string>();
  const qwenCoderFilled = new Set<string>();
  const dsReviewFilled = new Set<string>();
  const qwenReviewFilled = new Set<string>();

  // ── Helper: DeepSeek combine helper ────────────────────────────────────────
  const deepseekCombine = async (
    systemPrompt: string,
    filesToAttach: string[],
    stepLabel: string,
    latestReview?: string,
  ): Promise<string> => {
    onStatus(`[DeepSeek] ${stepLabel}...`);
    // Create a temporary directory for synthesis files
    const synthDir = path.join(outDir, `synth_${Date.now()}`);
    fs.mkdirSync(synthDir, { recursive: true });
    for (const f of filesToAttach) {
      fs.copyFileSync(f, path.join(synthDir, path.basename(f)));
    }

    if (latestReview) {
      fs.writeFileSync(path.join(synthDir, "latest_review.txt"), latestReview, "utf-8");
    }

    const res = await askDeepseek(
      persistentPages.dsSynthesizer!,
      systemPrompt,
      "", // No manifest needed for synthesis
      synthDir,
      (msg) => onStatus(`[DeepSeek ${stepLabel}] ${msg}`),
      outDir,
      false, // isFirstTurn = false to skip manifest/metadata upload
    );
    try {
      fs.rmSync(synthDir, { recursive: true, force: true });
    } catch {}
    return res;
  };

  // Track whether each role has already uploaded files (so we know first-turn vs follow-up)
  let coderFirstTurn = true; // first CODER turn ever (upload base context)
  let reviewerFirstTurn = true; // first REVIEWER turn ever (upload combined_response)

  let activeResponsePath = ""; // path to current combined_response_N.txt
  let finalSynthesis = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    onStatus(`=== Round ${round} ===`);

    // ────────────────────────────────────────────────────────────────────────
    // CODER PHASE
    // ────────────────────────────────────────────────────────────────────────
    const coderPrompt =
      round === 0
        ? getDeepseekCodingPrompt({ userQuery: query, mode: "FIX" })
        : getCoderRefinementPrompt({
            userQuery: query,
            owner,
            repo,
            defaultBranch,
            hasLatestResponse: !!activeResponsePath,
          });

    // Build coder upload dir
    let coderUploadDir: string | null = null;
    if (coderFirstTurn) {
      // First coder turn: upload entire base context
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
      // Subsequent coder turns: upload ONLY the latest combined_review
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
        coderPrompt,
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
      ),
      runSingleModelTurn(
        "Qwen",
        persistentPages.qwenCoder!,
        coderPrompt,
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
      ),
    ]);
    coderFirstTurn = false;

    // Cleanup coder upload dir
    if (coderUploadDir && fs.existsSync(coderUploadDir)) {
      try {
        fs.rmSync(coderUploadDir, { recursive: true, force: true });
      } catch {}
    }

    // Save raw coder outputs
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

    // DeepSeek synthesises coder outputs → combined_response_N.txt
    const coderSynthesis = await deepseekCombine(
      getGeminiSynthesisPrompt({
        synthesisPrompt: query,
        latestReview: round > 0 ? finalSynthesis : undefined,
      }),
      [rawCoderPath],
      `Synthesizing coder outputs (round ${round})`,
      round > 0 ? finalSynthesis : undefined,
    );

    activeResponsePath = path.join(outDir, `combined_response_${round}.txt`);
    fs.writeFileSync(activeResponsePath, coderSynthesis, "utf-8");
    
    // Save a full debug version containing raw coder outputs + synthesis
    const debugResponsePath = path.join(outDir, `combined_response_debug_${round}.txt`);
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
    onStatus(`combined_response_${round}.txt (clean synthesis) and debug log written.`);

    // Surface intermediate answer to user
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

    // ────────────────────────────────────────────────────────────────────────
    // REVIEWER PHASE
    // ────────────────────────────────────────────────────────────────────────
    const reviewerPrompt = getCodeReviewPrompt({
      userQuery: query,
      owner,
      repo,
      defaultBranch,
    });

    // Build reviewer upload dir — always send the latest combined_response
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
        reviewerPrompt,
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
      ),
      runSingleModelTurn(
        "Qwen",
        persistentPages.qwenReviewer!,
        reviewerPrompt,
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
      ),
    ]);
    reviewerFirstTurn = false;

    // Cleanup reviewer upload dir
    if (fs.existsSync(reviewerUploadDir)) {
      try {
        fs.rmSync(reviewerUploadDir, { recursive: true, force: true });
      } catch {}
    }

    // Save raw review outputs
    const rawReviewBlock = [
      `// REVIEWER_A (DeepSeek) — Round ${round}`,
      dsReviewRaw || "// [No response]",
      "",
      `// REVIEWER_B (Qwen) — Round ${round}`,
      qwenReviewRaw || "// [No response]",
    ].join("\n");

    const rawReviewPath = path.join(outDir, `combined_review_raw_${round}.txt`);
    fs.writeFileSync(rawReviewPath, rawReviewBlock, "utf-8");

    // DeepSeek synthesises reviewer outputs → combined_review_N.txt
    const reviewSynthesis = await deepseekCombine(
      getReviewSynthesisPrompt(),
      [rawReviewPath],
      `Synthesizing reviewer outputs (round ${round})`,
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
    onStatus(`combined_review_${round}.txt written.`);

    finalSynthesis = reviewSynthesis;

    // Check if reviewers are satisfied
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
    // Loop continues; next iteration coderFirstTurn=false so coders get combined_review
  }

  return finalSynthesis;
}
