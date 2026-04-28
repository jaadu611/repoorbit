import { buildMasterContext } from "@/lib/contextBuilder";
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
} from "@/lib/prompts";
import { NextResponse } from "next/server";
import { Page, BrowserContext } from "playwright";
import { JobStatus } from "@/lib/types";

export const CONTEXT_DIR_PATH = "/tmp/notebooklm_sources";

const GLOBAL_JOBS_KEY = Symbol.for("repoorbit.playwright.jobs");
export const activeJobs: Map<string, JobStatus> =
  (global as any)[GLOBAL_JOBS_KEY] || new Map();
(global as any)[GLOBAL_JOBS_KEY] = activeJobs;

// ─── Constants & Helpers ──────────────────────────────────────────────────

const MAX_LINES_PER_FILE = 500;
const MAX_FILES_PER_TURN = 5;

async function fetchFile(
  outDir: string,
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  lineRange?: [number, number],
): Promise<string> {
  const safeBranch = branch && branch.trim() ? branch.trim() : "main";
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${safeBranch}/${filePath}`;
  console.log(`[GITHUB] Fetching: ${url}`);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[GITHUB] 404/Error: ${url} (Status: ${res.status})`);
      return `// [NOT FOUND] ${filePath} — HTTP ${res.status}`;
    }
    const text = await res.text();
    const lines = text.split("\n");

    console.log(
      `[GITHUB] Success: ${filePath} (${lines.length} lines). Preview: ${lines[0].substring(0, 50)}...`,
    );

    if (lineRange) {
      let start = lineRange[0];
      let end = lineRange[1];

      // Interpret 0 as 'beginning' or 'end'
      const startIdx = start > 0 ? start - 1 : 0;
      const endIdx = end > 0 ? Math.min(lines.length - 1, end - 1) : lines.length - 1;

      const slice = lines.slice(startIdx, endIdx + 1);
      // If they asked for a range, we give them what they asked for (up to 1500 lines)
      const MAX_RANGE_LIMIT = 1500;
      if (slice.length > MAX_RANGE_LIMIT) {
        return (
          slice.slice(0, MAX_RANGE_LIMIT).join("\n") +
          `\n\n// [TRUNCATED] Only first ${MAX_RANGE_LIMIT} lines of the requested range are shown. Ask for the next segment if needed.`
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

async function fillMissingFiles(
  missingFiles: any[],
  filledSet: Set<string>,
  modelName: string,
  modelInvestDir: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<number> {
  const filesToFetch = missingFiles.slice(0, MAX_FILES_PER_TURN);
  let count = 0;

  for (const f of filesToFetch) {
    const filePath = f.path || f.file_path;
    if (!filePath) continue;
    const lineRange = Array.isArray(f.line_range) ? f.line_range : undefined;
    const key = `${filePath}|${lineRange?.join(",") || ""}`.toLowerCase();
    if (filledSet.has(key)) continue;
    filledSet.add(key);

    console.log(
      `[ORCHESTRATOR] ${modelName} fetching: ${filePath}${lineRange ? ` lines ${lineRange.join("-")}` : ""}`,
    );
    const content = await fetchFile(
      modelInvestDir
        .split("/ds_investigation")[0]
        .split("/qwen_investigation")[0],
      owner,
      repo,
      branch,
      filePath,
      lineRange as [number, number],
    );

    const safeName = filePath.replace(/[^a-zA-Z0-9_-]/g, "_");
    const extraFileName = `extra_${count.toString().padStart(2, "0")}_${safeName}.txt`;
    const extraFilePath = path.join(modelInvestDir, extraFileName);
    fs.mkdirSync(modelInvestDir, { recursive: true });
    fs.writeFileSync(extraFilePath, content, "utf-8");
    console.log(
      `[ORCHESTRATOR] ${modelName}: Saved extra context to ${extraFileName}`,
    );
    count++;
  }

  console.log(
    `[ORCHESTRATOR] ${modelName}: Total extra files fetched this turn: ${count}`,
  );
  return count;
}

function fileFingerprint(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return `${content.length}:${content.slice(0, 64)}`;
  } catch {
    return `missing:${filePath}`;
  }
}

function prepareTurnDir(
  outDir: string,
  modelPrefix: string,
  attempt: number,
  dsBaseContextDir: string,
  modelInvestDir: string,
  seenHashes: Map<string, string>,
): string {
  const turnDir = path.join(outDir, `${modelPrefix}_upload_${attempt}`);
  if (fs.existsSync(turnDir))
    fs.rmSync(turnDir, { recursive: true, force: true });
  fs.mkdirSync(turnDir, { recursive: true });

  let newFilesCount = 0;

  // 1. Base Context: ONLY on first turn (attempt 0)
  if (attempt === 0 && fs.existsSync(dsBaseContextDir)) {
    for (const f of fs.readdirSync(dsBaseContextDir)) {
      if (f === "gap_filler.txt") continue;
      const src = path.join(dsBaseContextDir, f);
      const dst = path.join(turnDir, f);
      const fingerprint = fileFingerprint(src);
      fs.copyFileSync(src, dst);
      seenHashes.set(f, fingerprint);
      newFilesCount++;
    }
  }

  // 2. Extra Context: ONLY new files that haven't been uploaded yet
  if (fs.existsSync(modelInvestDir)) {
    for (const f of fs.readdirSync(modelInvestDir)) {
      const src = path.join(modelInvestDir, f);
      const fingerprint = fileFingerprint(src);
      const existing = seenHashes.get(f);

      if (existing === fingerprint) continue;

      fs.copyFileSync(src, path.join(turnDir, f));
      seenHashes.set(f, fingerprint);
      newFilesCount++;
    }
  }

  console.log(
    `[ORCHESTRATOR] ${modelPrefix} turn ${attempt}: prepared ${newFilesCount} NEW files in ${turnDir}`,
  );
  return turnDir;
}

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
  let history = "";
  const initialPrompt = getGeminiPlannerPrompt(query);
  history = initialPrompt;

  const parts = repoUrl.split("/");
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];

  let currentFiles = [...plannerFiles];

  while (attempts < 3) {
    let response = "";
    if (modelName === "Gemini") {
      response = await askGemini(
        page,
        history,
        attempts === 0 ? currentFiles : [],
        (msg) => onStatus(`[Gemini Planner] ${msg}`),
      );
    } else if (modelName === "DeepSeek") {
      const planContextDir = path.join(outDir, "planner_context_ds");
      if (attempts === 0) {
        fs.mkdirSync(planContextDir, { recursive: true });
        currentFiles.forEach((f) =>
          fs.copyFileSync(f, path.join(planContextDir, path.basename(f))),
        );
      }
      response = await askDeepseek(
        page,
        history,
        manifestContent,
        attempts === 0 ? planContextDir : "",
        (msg) => onStatus(`[DeepSeek Planner] ${msg}`),
        outDir,
        attempts === 0,
      );
    } else if (modelName === "Qwen") {
      const planContextDir = path.join(outDir, "planner_context_qwen");
      if (attempts === 0) {
        fs.mkdirSync(planContextDir, { recursive: true });
        currentFiles.forEach((f) =>
          fs.copyFileSync(f, path.join(planContextDir, path.basename(f))),
        );
      }
      response = await askQwen(
        page,
        history,
        manifestContent,
        attempts === 0 ? planContextDir : "",
        (msg) => onStatus(`[Qwen Planner] ${msg}`),
        outDir,
        attempts === 0,
      );
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
      console.warn(
        `[${modelName} Planner] Raw response (first 500 chars): ${response.substring(0, 500)}`,
      );
      return { status: "FAILED", raw: response };
    }

    console.log(`[${modelName} Planner] Parsed plan status: ${plan.status}`);
    if (plan.status === "READY" || plan.status === "GENERIC") return plan;

    if (plan.status === "NEED_FILE" && Array.isArray(plan.files)) {
      onStatus(`[${modelName} Planner] Fetching requested files...`);
      const results = [];
      for (const f of plan.files.slice(0, 5)) {
        const content = await fetchFile(
          outDir,
          owner,
          repo,
          defaultBranch,
          f.path,
        );
        results.push(`${f.path}:\n${content}`);
      }

      history += "\n\n" + response;
      history += "\n\n" + results.join("\n\n");
      attempts++;
      continue;
    }
    console.warn(`[${modelName} Planner] Unhandled plan status "${plan.status}". Returning as-is.`);
    return plan;
  }
  console.warn(`[${modelName} Planner] Exhausted all attempts without a final plan.`);
  return { status: "FAILED" };
}

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
    `[Dual Planner] Results — DeepSeek: ${dPlan.status}, Qwen: ${qPlan.status}`,
  );

  // Close planner tabs to save resources
  await Promise.allSettled([deepPage.close(), qwenPage.close()]);

  // If both failed, return failed
  if (dPlan.status === "FAILED" && qPlan.status === "FAILED") {
    return { status: "FAILED" };
  }

  // GENERIC routing: GENERIC wins when it has at least as many votes as READY
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

    if (allGenericNotebooks.length === 0) {
      return { status: "GENERIC", reason: genericReason, notebooks: [] };
    }

    // Use Gemini ONLY for synthesis — open page on demand
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

  // Only feed READY plans into the synthesizer
  const readyPlans: Record<string, any> = {};
  if (dPlan.status === "READY") readyPlans["DEEPSEEK"] = dPlan;
  if (qPlan.status === "READY") readyPlans["QWEN"] = qPlan;

  // If only one planner returned READY, skip synthesis and use it directly
  const readyEntries = Object.entries(readyPlans);
  if (readyEntries.length === 1) {
    onStatus(`Using ${readyEntries[0][0]}'s plan directly (only 1 READY).`);
    return readyEntries[0][1];
  }

  // Both READY — synthesize with Gemini
  const geminiPage =
    context.pages().find((p) => p.url().includes("gemini.google.com")) ||
    (await context.newPage());

  const planEntries = readyEntries
    .map(([name, plan]) => `${name}: ${JSON.stringify(plan)}`)
    .join("\n");

  onStatus(`Synthesizing unified plan with Gemini (${readyEntries.length}/2 READY plans)...`);
  const synthPrompt = `Synthesize these investigation plans into a SINGLE, EXHAUSTIVE, and COMPREHENSIVE master plan.

PRIORITY: MAXIMIZE COVERAGE
1. MISSION: It is better to include an extra notebook than to miss the bug. If any agent identifies a specific notebook or logic area, INCLUDE IT in the final plan.
2. DO NOT be overly selective. Combine the unique insights from all planners.
3. MERGE DUPLICATES: Each notebook name must appear ONLY ONCE in your JSON. If multiple models suggested the same notebook, merge their sub-questions into a single, highly detailed, multi-part investigation query for that notebook.
4. VALIDATION: Return ONLY a valid JSON object with {"status": "READY", "notebooks": [...]}.

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
    } catch (err) {
      console.error("[NotebookLM] Failed to parse notebooks.json:", err);
    }
  }

  for (const plan of notebookPlans) {
    const plannedName = plan.name;
    const subQuestion = plan.sub_question;

    const nb = notebooks.find(
      (n) => n.name === plannedName || n.title === plannedName,
    );
    if (!nb) {
      console.warn(
        `[NotebookLM] Planner requested unknown notebook: ${plannedName}`,
      );
      continue;
    }

    console.log(
      `[ORCHESTRATOR] Querying NotebookLM: "${nb.title}" with ${nb.localFiles?.length || 0} files...`,
    );
    const files = await automateSubQuestion(
      page,
      nb.title,
      getNotebookSubQuestionPrompt(subQuestion),
      nb.localFiles,
    );

    if (Array.isArray(files)) {
      console.log(
        `[ORCHESTRATOR] NotebookLM "${nb.title}" returned ${files.length} files.`,
      );
      files.forEach((f) => {
        if (f !== "notebook_instructions.txt" && f !== "00_manifest.txt") {
          allFiles.add(f);
        }
      });
    }
  }

  console.log(
    `[ORCHESTRATOR] Total unique context files gathered from NotebookLM: ${allFiles.size}`,
  );
  return Array.from(allFiles);
}

// ─── Generic question deep analysis via NotebookLM ────────────────────────────

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
    } catch (err) {
      console.error("[Generic] Failed to parse notebooks.json:", err);
    }
  }

  for (const plan of notebookPlans) {
    const plannedName = plan.name;
    const subQuestion = plan.sub_question;

    const nb = notebooks.find(
      (n) => n.name === plannedName || n.title === plannedName,
    );
    if (!nb) {
      console.warn(`[Generic] Unknown notebook: ${plannedName}`);
      continue;
    }

    onStatus(`Querying notebook "${nb.title}" for deep context...`);
    console.log(
      `[GENERIC ORCHESTRATOR] Querying "${nb.title}" with ${nb.localFiles?.length || 0} files...`,
    );

    try {
      const answer = await automateNotebookLM(
        page,
        nb.localFiles || [],
        getGenericNotebookPrompt(subQuestion),
        nb.title,
        (msg) => onStatus(`[NotebookLM] ${msg}`),
        false,
      );

      answers.push({ sub_question: subQuestion, answer, notebook: nb.title });
      console.log(
        `[GENERIC ORCHESTRATOR] Got answer from "${nb.title}" (${answer.length} chars)`,
      );
    } catch (err: any) {
      console.error(`[Generic] Error querying "${nb.title}":`, err.message);
      answers.push({
        sub_question: subQuestion,
        answer: `[Error retrieving answer: ${err.message}]`,
        notebook: nb.title,
      });
    }
  }

  return answers;
}

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
    [insightsPath, queryPromptPath].forEach((file) => {
      if (fs.existsSync(file)) fs.unlinkSync(file);
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
            console.error("[CLONE] git clone failed:", cloneErr.message);
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

          setStatus("Building master context via Central Builder...");
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
            undefined, // expertPlan
            true, // dumpAll
          );

          // Cleanup raw clone
          fs.rmSync(tmpRepoDir, { recursive: true, force: true });
          setStatus("Context built. Starting planning...");
        }

        // ── Step 2: Intelligent Triple-Model Planning ────────────────────────
        const context = await getOrCreateContext();
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

        if (plan.status === "GENERIC") {
          setStatus("Generic question: querying notebooks for deep codebase analysis...");

          // ── Step 2b: Query each relevant notebook for a detailed text answer ───
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

          // ── Step 2c: Build a rich synthesis prompt for ChatGPT ───────────────
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
The following are detailed analyses extracted from specialised notebooks, each targeting a specific aspect of the main question:

${answersBlock}

---
Synthesize all the insights above into a single, cohesive, well-structured response to the main question. Be comprehensive and precise. Reference specific findings from the analyses above where relevant.`;

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
            error:
              "Gemini planner failed to generate a valid investigation plan.",
          });
          return;
        }

        // ── Step 3: Collect relevant files via NotebookLM ────────────────────
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

        // ── Step 4: Final Synthesis Setup ─────────────────────────────────────
        setStatus("Building precise code context for model orchestration...");
        const dsBaseContextDir = path.join(outDir, "deepseek_context");
        if (fs.existsSync(dsBaseContextDir))
          fs.rmSync(dsBaseContextDir, { recursive: true, force: true });
        fs.mkdirSync(dsBaseContextDir, { recursive: true });

        // Fetch the collected files (individual files for upload)
        for (let i = 0; i < contextFiles.length; i++) {
          const filePath = contextFiles[i];
          const content = await fetchFile(
            outDir,
            owner,
            repo,
            defaultBranch,
            filePath,
          );
          const safeName = filePath.replace(/[^a-zA-Z0-9_-]/g, "_");
          fs.writeFileSync(
            path.join(
              dsBaseContextDir,
              `file_${i.toString().padStart(2, "0")}_${safeName}.js`,
            ),
            content,
            "utf-8",
          );
        }

        // ── Step 5: Model Orchestration Loop ──────────────────────────────────
        const dsPromptString = getDeepseekCodingPrompt({
          userQuery: query,
          mode: "FIX",
        });

        let deepPage = context
          .pages()
          .find((p: any) => p.url()?.includes("chat.deepseek.com"));
        if (!deepPage) deepPage = await context.newPage();
        let qwenPage = context
          .pages()
          .find((p: any) => p.url()?.includes("chat.qwen.ai"));
        if (!qwenPage) qwenPage = await context.newPage();

        let dsDone = false;
        let qwenDone = false;
        let dsRaw = "";
        let qwenRaw = "";
        const dsFilledSymbols = new Set<string>();
        const qwenFilledSymbols = new Set<string>();
        const dsUploadedHashes = new Map<string, string>();
        const qwenUploadedHashes = new Map<string, string>();

        const dsInvestDir = path.join(outDir, "ds_investigation");
        const qwenInvestDir = path.join(outDir, "qwen_investigation");
        fs.mkdirSync(dsInvestDir, { recursive: true });
        fs.mkdirSync(qwenInvestDir, { recursive: true });

        let dsAttempt = 0;
        while (!dsDone || !qwenDone) {
          if (dsAttempt > 50) {
            console.warn("[ORCHESTRATOR] Safety break: reached 50 turns.");
            break;
          }

          const dsTurnDir = dsDone
            ? ""
            : prepareTurnDir(
                outDir,
                "ds",
                dsAttempt,
                dsBaseContextDir,
                dsInvestDir,
                dsUploadedHashes,
              );
          const qwenTurnDir = qwenDone
            ? ""
            : prepareTurnDir(
                outDir,
                "qwen",
                dsAttempt,
                dsBaseContextDir,
                qwenInvestDir,
                qwenUploadedHashes,
              );

          const dsNewFilesCount = dsDone ? 0 : fs.readdirSync(dsTurnDir).length;
          const qwenNewFilesCount = qwenDone
            ? 0
            : fs.readdirSync(qwenTurnDir).length;

          console.log(
            `[ORCHESTRATOR] Starting Turn ${dsAttempt} in parallel...`,
          );
          setStatus(
            `Turn ${dsAttempt} [DS: ${dsDone ? "✓" : "pending"}, Qwen: ${qwenDone ? "✓" : "pending"}]`,
          );

          const turnPrompt =
            dsAttempt === 0
              ? dsPromptString
              : "Here are the files you requested. Please continue with your investigation.";

          // Parallel Execution with allSettled — both models run concurrently
          const [dsRes, qwenRes] = await Promise.allSettled([
            !dsDone && (dsAttempt === 0 || dsNewFilesCount > 0)
              ? askDeepseek(
                  deepPage!,
                  turnPrompt,
                  rootManifestContent,
                  dsTurnDir,
                  (msg, partial, prog) =>
                    setStatus(`[Deepseek] ${msg}`, partial, prog),
                  outDir,
                  dsAttempt === 0,
                )
              : Promise.resolve(dsRaw),
            !qwenDone && (dsAttempt === 0 || qwenNewFilesCount > 0)
              ? askQwen(
                  qwenPage!,
                  turnPrompt,
                  rootManifestContent,
                  qwenTurnDir,
                  (msg, partial, prog) =>
                    setStatus(`[Qwen] ${msg}`, partial, prog),
                  outDir,
                  dsAttempt === 0,
                )
              : Promise.resolve(qwenRaw),
          ]);

          if (dsRes.status === "fulfilled") {
            // ONLY update dsRaw if we actually made a call!
            // If dsRes was bypassed, it resolved with the existing dsRaw anyway.
            if (!dsDone && (dsAttempt === 0 || dsNewFilesCount > 0)) {
               dsRaw = dsRes.value;
            }
          } else {
            console.warn("[ORCHESTRATOR] DeepSeek error:", dsRes.reason);
            dsDone = true; // Abort DS if it errored to escape loop
          }
          if (qwenRes.status === "fulfilled") {
            if (!qwenDone && (dsAttempt === 0 || qwenNewFilesCount > 0)) {
               qwenRaw = qwenRes.value;
            }
          } else {
            console.warn("[ORCHESTRATOR] Qwen error:", qwenRes.reason);
            qwenDone = true;
          }

          if (!dsDone) {
            try {
              if (!dsRaw) {
                console.warn(
                  "[ORCHESTRATOR] DeepSeek raw response is empty. Retrying next turn...",
                );
              } else {
                const cleaned = dsRaw.replace(/```json|```/g, "").trim();
                const s = cleaned.indexOf("{");
                const e = cleaned.lastIndexOf("}");
                if (s !== -1 && e > s) {
                  const data = JSON.parse(cleaned.slice(s, e + 1));
                  if (data.status === "NEED_MORE_CONTEXT") {
                    const mFiles = data.missing_files || data.missing_symbols;
                    const realCount = await fillMissingFiles(
                      mFiles,
                      dsFilledSymbols,
                      "DeepSeek",
                      dsInvestDir,
                      owner,
                      repo,
                      defaultBranch,
                    );
                    if (realCount === 0) {
                      console.log(
                        "[ORCHESTRATOR] DeepSeek: No new context files. Done.",
                      );
                      dsDone = true;
                    }
                  } else {
                    console.log(
                      `[ORCHESTRATOR] DeepSeek: Status ${data.status}. Done.`,
                    );
                    dsDone = true;
                  }
                } else {
                  console.warn(
                    "[ORCHESTRATOR] DeepSeek: No JSON in response. Marking done.",
                  );
                  dsDone = true;
                }
              }
            } catch (err: any) {
              console.error(
                "[ORCHESTRATOR] DeepSeek parse error:",
                err.message,
              );
            }
          }

          if (!qwenDone) {
            try {
              if (!qwenRaw) {
                console.warn(
                  "[ORCHESTRATOR] Qwen raw response is empty. Retrying next turn...",
                );
              } else {
                const cleaned = qwenRaw.replace(/```json|```/g, "").trim();
                const s = cleaned.indexOf("{");
                const e = cleaned.lastIndexOf("}");
                if (s !== -1 && e > s) {
                  const data = JSON.parse(cleaned.slice(s, e + 1));
                  if (data.status === "NEED_MORE_CONTEXT") {
                    const mFiles = data.missing_files || data.missing_symbols;
                    const realCount = await fillMissingFiles(
                      mFiles,
                      qwenFilledSymbols,
                      "Qwen",
                      qwenInvestDir,
                      owner,
                      repo,
                      defaultBranch,
                    );
                    if (realCount === 0) {
                      console.log(
                        "[ORCHESTRATOR] Qwen: No new context files. Done.",
                      );
                      qwenDone = true;
                    }
                  } else {
                    console.log(
                      `[ORCHESTRATOR] Qwen: Status ${data.status}. Done.`,
                    );
                    qwenDone = true;
                  }
                } else {
                  console.warn(
                    "[ORCHESTRATOR] Qwen: No JSON in response. Marking done.",
                  );
                  qwenDone = true;
                }
              }
            } catch (err: any) {
              console.error("[ORCHESTRATOR] Qwen parse error:", err.message);
            }
          }
          dsAttempt++;
        }

        console.log(
          `[ORCHESTRATOR] Loop finished after ${dsAttempt} turns. DS: ${dsDone}, Qwen: ${qwenDone}`,
        );

        // Close orchestration tabs before final synthesis
        await Promise.allSettled([deepPage.close(), qwenPage.close()]);

        // ── Step 6: Final Synthesis ───────────────────────────────────────────

        const checkInvalid = (raw: string) => {
          if (!raw) return false;
          try {
            const cleaned = raw.replace(/```json|```/g, "").trim();
            const s = cleaned.indexOf("{");
            const e = cleaned.lastIndexOf("}");
            if (s !== -1 && e > s) {
              const data = JSON.parse(cleaned.slice(s, e + 1));
              return data.status === "INVALID_QUESTION";
            }
          } catch {}
          return false;
        };

        if (checkInvalid(dsRaw) && checkInvalid(qwenRaw)) {
          console.log(
            "[ORCHESTRATOR] Both agents returned INVALID_QUESTION. Aborting synthesis.",
          );
          activeJobs.set(taskId, {
            status: "done",
            result: `Both investigation agents evaluated your query and determined it is an INVALID_QUESTION.\n\n### DeepSeek:\n${dsRaw}\n\n### Qwen:\n${qwenRaw}`,
            answerSource: "final",
          });
          return;
        }

        const combinedResult = [
          "// DEEPSEEK RESPONSE",
          dsRaw || "// [No response]",
          "",
          "// QWEN RESPONSE",
          qwenRaw || "// [No response]",
        ].join("\n");

        const combinedPath = path.join(outDir, "combined_responses.txt");
        fs.writeFileSync(combinedPath, combinedResult, "utf-8");

        setStatus("Synthesizing final answer with Gemini...");
        const geminiPage =
          context.pages().find((p) => p.url().includes("gemini.google.com")) ||
          (await context.newPage());

        const synthesisFiles = [combinedPath];

        const finalResult = await askGemini(
          geminiPage,
          getGeminiSynthesisPrompt({ synthesisPrompt: query }),
          synthesisFiles,
          (msg) => setStatus(`[Gemini] ${msg}`),
        );

        activeJobs.set(taskId, {
          status: "done",
          result: finalResult,
          answerSource: "final",
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
