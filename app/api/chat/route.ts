import { buildMasterContext } from "@/lib/contextBuilder";
import path from "path";
import fs from "fs";
import { analyzeFile, fetchFileContents } from "@/lib/github";
import { automateNotebookLM } from "@/lib/notebooklmAutomator";
import { automateChatGPT } from "@/lib/chatgptAutomator";
import { getOrCreateContext } from "@/lib/browser";
import { generateGapFillerNotebook } from "@/lib/gapScout";
import { askDeepseek } from "@/lib/deepseekAutomator";
import { buildDeepseekContext } from "@/lib/deepseekContextBuilder";
import {
  getFinalPhasePrompt,
  getArchitectPrompt,
  getStaffEngineerPrompt,
  getDeepseekCodingPrompt,
} from "@/lib/prompts";
import { NextResponse } from "next/server";
import { BrowserContext } from "playwright";
import {
  JobStatus,
  NotebookPlan,
  RepoLanguage,
  FinalPhaseResult,
  MissingContextResult,
} from "@/lib/types";

export const CONTEXT_DIR_PATH = "/tmp/notebooklm_sources";
export const NOTEBOOKLM_URL = "https://notebooklm.google.com/";

const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".txt",
  ".md",
  ".docx",
  ".csv",
  ".pptx",
  ".epub",
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jp2",
  ".png",
  ".webp",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".jpe",
  ".3g2",
  ".3gp",
  ".aac",
  ".aif",
  ".aifc",
  ".aiff",
  ".amr",
  ".au",
  ".avi",
  ".cda",
  ".m4a",
  ".mid",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".ogg",
  ".opus",
  ".ra",
  ".ram",
  ".snd",
  ".wav",
  ".wma",
]);

const GLOBAL_JOBS_KEY = Symbol.for("repoorbit.playwright.jobs");
export const activeJobs: Map<string, JobStatus> =
  (global as any)[GLOBAL_JOBS_KEY] || new Map();
(global as any)[GLOBAL_JOBS_KEY] = activeJobs;

// ─── Notebook relevance scorer ────────────────────────────────────────────────

const SCORER_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "in",
  "it",
  "of",
  "to",
  "and",
  "or",
  "for",
  "on",
  "with",
  "this",
  "that",
  "from",
  "are",
  "was",
  "be",
  "by",
  "at",
  "as",
  "we",
  "i",
  "my",
  "our",
  "your",
  "its",
  "have",
  "has",
  "had",
  "not",
  "do",
  "does",
  "did",
  "can",
  "could",
  "would",
  "should",
  "will",
  "may",
  "might",
  "how",
  "what",
  "where",
  "when",
  "which",
  "who",
  "why",
  "there",
  "here",
  "after",
  "before",
  "under",
  "over",
  "about",
]);

const CORE_SOURCE_BONUS_RE = /^(lib|src|core|internal|pkg|cmd|server)\//;
const TEST_FILE_PENALTY_RE = /\.(test|spec)\.[a-z]+$|\/test\/|\/tests?\//;

function isNeverRelevant(filePath: string): boolean {
  const p = filePath.toLowerCase();
  if (p.startsWith(".github/") || p === ".github") return true;
  if (p.startsWith("docs/")) return true;
  if (p.startsWith("build/")) return true;
  if (p.startsWith("scripts/")) return true;
  if (p.startsWith("examples/") && !p.includes("benchmark")) return true;
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return true;
  if (p.endsWith(".md")) return true;
  if (p.endsWith(".json") && !p.endsWith("package.json")) return true;
  return false;
}

function extractQueryTokens(query: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = query.toLowerCase().replace(/[^a-z0-9\s_./-]/g, " ");

  for (const m of normalized.matchAll(/\b[\w-]+\/[\w-]+(?:\.[a-z]{1,5})?\b/g)) {
    tokens.add(m[0]);
  }
  for (const m of query.matchAll(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g)) {
    tokens.add(m[0].toLowerCase());
  }
  for (const m of query.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/g)) {
    tokens.add(m[0]);
  }
  for (const w of normalized.split(/\s+/)) {
    const clean = w.replace(/[^a-z0-9]/g, "");
    if (clean.length >= 3 && !SCORER_STOP_WORDS.has(clean)) {
      tokens.add(clean);
    }
  }

  return tokens;
}

interface NotebookScore {
  notebookName: string;
  score: number;
  tier: "HIGH" | "MEDIUM" | "LOW";
  matchedFiles: string[];
  totalFiles: number;
}

function scoreNotebooksForQuery(
  outDir: string,
  query: string,
): NotebookScore[] {
  const tokens = extractQueryTokens(query);
  const scores: NotebookScore[] = [];

  const manifestPath = path.join(outDir, "00_Root_Manifest.txt");
  if (!fs.existsSync(manifestPath)) {
    console.error("[SCORER] 00_Root_Manifest.txt not found at:", manifestPath);
    return [];
  }

  const manifestContent = fs.readFileSync(manifestPath, "utf-8");

  // FIX: \r? handles both CRLF (Windows) and LF (Unix) line endings.
  // The old regex /^## (notebook_\d+)$/gm failed on CRLF because $
  // matched before \r, so "## notebook_01\r" did not match.
  const notebookMatches = manifestContent.matchAll(/^## (notebook_\d+)\r?$/gm);
  const notebookNames: string[] = [];
  for (const m of notebookMatches) {
    notebookNames.push(m[1]);
  }

  // FALLBACK: if manifest regex found nothing, scan disk directly.
  // Handles edge cases where manifest format has drifted.
  if (notebookNames.length === 0) {
    console.warn(
      "[SCORER] No notebook names found via manifest regex — scanning disk",
    );
    try {
      const entries = fs.readdirSync(outDir);
      for (const entry of entries) {
        if (/^notebook_\d+$/.test(entry)) {
          const fullPath = path.join(outDir, entry);
          if (fs.statSync(fullPath).isDirectory()) {
            notebookNames.push(entry);
          }
        }
      }
      notebookNames.sort();
    } catch (e) {
      console.error("[SCORER] Failed to scan disk for notebooks:", e);
    }
  }

  if (notebookNames.length === 0) {
    console.error(
      "[SCORER] No notebooks found in manifest or on disk. outDir:",
      outDir,
    );
    return [];
  }

  for (const notebookName of notebookNames) {
    const localManifestPath = path.join(
      outDir,
      notebookName,
      "00_manifest.txt",
    );
    if (!fs.existsSync(localManifestPath)) continue;

    const localManifest = fs.readFileSync(localManifestPath, "utf-8");

    const fileEntries: string[] = [];
    for (const m of localManifest.matchAll(/^file_\d+_NB\d+\.txt -> (.+)$/gm)) {
      fileEntries.push(m[1].trim());
    }

    let notebookScore = 0;
    const matchedFilesWithScore: { path: string; score: number }[] = [];

    for (const filePath of fileEntries) {
      if (isNeverRelevant(filePath)) continue;

      const filePathLower = filePath.toLowerCase();
      let fileScore = 0;

      if (tokens.size > 0) {
        for (const token of tokens) {
          if (filePathLower.includes(token)) {
            fileScore += 10;
          }
        }
      }

      if (fileScore > 0 || CORE_SOURCE_BONUS_RE.test(filePath)) {
        const lineMatch = localManifest.match(
          new RegExp(
            `(file_\\d+_NB\\d+\\.txt) -> ${filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
          ),
        );
        if (lineMatch) {
          const txtFilePath = path.join(outDir, notebookName, lineMatch[1]);
          if (fs.existsSync(txtFilePath)) {
            const content = fs.readFileSync(txtFilePath, "utf-8").toLowerCase();
            if (tokens.size > 0) {
              for (const token of tokens) {
                const occurrences = (
                  content.match(new RegExp(`\\b${token}\\b`, "g")) ?? []
                ).length;
                fileScore += Math.min(occurrences, 5) * 3;
              }
            } else {
              // No tokens — give core source files a base score so they surface
              fileScore += 10;
            }
          }
        }
      }

      if (CORE_SOURCE_BONUS_RE.test(filePath)) {
        fileScore = Math.round(fileScore * 1.5);
      }
      if (TEST_FILE_PENALTY_RE.test(filePath) && fileScore > 0) {
        fileScore = Math.round(fileScore * 0.4);
      }

      if (fileScore > 0) {
        notebookScore += fileScore;
        matchedFilesWithScore.push({ path: filePath, score: fileScore });
      }
    }

    let tier: "HIGH" | "MEDIUM" | "LOW";
    if (notebookScore >= 200) tier = "HIGH";
    else if (notebookScore >= 50) tier = "MEDIUM";
    else tier = "LOW";

    const matchedFiles = matchedFilesWithScore
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((f) => f.path);

    scores.push({
      notebookName,
      score: notebookScore,
      tier,
      matchedFiles,
      totalFiles: fileEntries.length,
    });
  }

  return scores.sort((a, b) => b.score - a.score);
}

function buildQueryRelevanceSection(
  scores: NotebookScore[],
  query: string,
): string {
  if (scores.length === 0) return "";

  const queryPreview = query.length > 100 ? query.slice(0, 100) + "..." : query;

  const lines: string[] = [
    `## QUERY RELEVANCE ANALYSIS`,
    `Query: "${queryPreview}"`,
    ``,
    `The following notebooks have been pre-scored for relevance to this query.`,
    `Use this as your PRIMARY signal for notebook assignment.`,
    `HIGH relevance notebooks contain the files most likely needed to answer the query.`,
    `Do NOT assign LOW relevance notebooks as primary sources for code questions.`,
    ``,
  ];

  for (const s of scores) {
    const matchedStr =
      s.matchedFiles.length > 0
        ? s.matchedFiles.join(", ")
        : "no directly matched files";
    lines.push(
      `- ${s.notebookName} [${s.tier}] score:${s.score} — relevant files: ${matchedStr}`,
    );
  }

  lines.push(``);
  lines.push(
    `PLANNER INSTRUCTION: Your notebook assignments in the "covers" array MUST`,
  );
  lines.push(
    `prioritize HIGH-scored notebooks. For each HIGH notebook, write a sub_question`,
  );
  lines.push(
    `that is SPECIFIC to the query — not a general architectural overview.`,
  );
  lines.push(
    `If the query mentions a bug or fix, the sub_question must ask about that`,
  );
  lines.push(`specific bug in the context of the files in that notebook.`);

  return lines.join("\n");
}

function deriveNotebookPlan(
  scores: NotebookScore[],
  query: string,
): NotebookPlan {
  // 1. Try to get all HIGH notebooks
  let selected = scores.filter((s) => s.tier === "HIGH");

  // 2. If no HIGH, take the top 3 MEDIUM notebooks (increased from 2)
  if (selected.length === 0) {
    selected = scores.filter((s) => s.tier === "MEDIUM").slice(0, 3);
  }

  // 3. FALLBACK: If still empty or all are LOW, take the top 5 (increased from 2)
  if (selected.length === 0 && scores.length > 0) {
    console.warn(
      "[PLANNER] All notebooks scored LOW — using top 5 by score as fallback",
    );
    selected = scores.slice(0, 5);
  }

  // 4. Increase global limit to 5 notebooks total
  selected = selected.slice(0, 5);

  return {
    include_meta: false,
    notebooks: selected.map((s) => ({
      name: s.notebookName,
      covers: s.matchedFiles, // This list is controlled by the Scorer
      reason: `Scorer assigned ${s.tier} tier (score: ${s.score}). Top matched files: ${s.matchedFiles.slice(0, 3).join(", ")}`,
      sub_question: query,
    })),
  };
}

// ─── processNotebookPlan ──────────────────────────────────────────────────────

async function processNotebookPlan(
  context: BrowserContext,
  plan: NotebookPlan,
  baseDir: string,
  repoName: string,
  lang?: RepoLanguage,
  onStatus?: (msg: string, partial?: string, progress?: number) => void,
): Promise<string> {
  const pages = context.pages();
  let page = pages.find((p) => p.url()?.includes("notebooklm.google.com"));

  if (!page) {
    page = await context.newPage();
    await page.goto(NOTEBOOKLM_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  } else {
    await page.goto(NOTEBOOKLM_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  }

  const answers: string[] = [];
  if (!plan.notebooks) return "";
  const total = plan.notebooks.length;

  for (let i = 0; i < total; i++) {
    const nb = plan.notebooks[i];

    const numMatch = nb.name.match(/notebook[_-]?(\d+)/i);
    const resolvedFolderName = numMatch
      ? `notebook_${numMatch[1].padStart(2, "0")}`
      : `notebook_${String(i + 1).padStart(2, "0")}`;
    const notebookFolder = path.join(baseDir, resolvedFolderName);

    onStatus?.(
      `Querying ${resolvedFolderName} (${i + 1}/${total})...`,
      undefined,
      Math.round(((i + 1) / total) * 100),
    );

    if (!fs.existsSync(notebookFolder)) {
      answers.push(
        `### ${resolvedFolderName}\n[ERROR] Folder "${resolvedFolderName}" does not exist (planner name: "${nb.name}").\n`,
      );
      continue;
    }

    const allTxts = fs
      .readdirSync(notebookFolder)
      .filter((f) => f.endsWith(".txt"))
      .sort();

    const manifestFile = allTxts.find((f) => f === "00_manifest.txt");
    const sourceFiles = allTxts.filter(
      (f) => f !== "00_manifest.txt" && f !== "QUERY_PROMPT.txt",
    );
    const orderedFiles = [
      ...sourceFiles,
      ...(manifestFile ? [manifestFile] : []),
    ].map((f) => path.join(notebookFolder, f));
    const finalOrderedFiles = [...orderedFiles];

    if (finalOrderedFiles.length === 0) {
      answers.push(
        `### ${resolvedFolderName}\n[ERROR] No source files found in "${notebookFolder}".\n`,
      );
      continue;
    }

    const notebookTitle = `@${repoName} - ${nb.name}`;
    const queryPromptPath = path.join(notebookFolder, "QUERY_PROMPT.txt");

    let answer = "";
    try {
      const architectPrompt = getArchitectPrompt(
        nb.sub_question,
        nb.reason,
        nb.covers,
      );
      fs.writeFileSync(queryPromptPath, architectPrompt, "utf-8");

      answer = await automateNotebookLM(
        page,
        [queryPromptPath, ...finalOrderedFiles],
        "Process the instructions in QUERY_PROMPT.txt",
        notebookTitle,
        onStatus,
        false,
        [queryPromptPath],
      );
    } catch (err: any) {
      answer = `[Error] ${err.message}`;
    }

    answers.push(`### ${resolvedFolderName}\n\n${answer}\n`);

    if (i < total - 1) {
      await page.goto(NOTEBOOKLM_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(2000);
    }
  }

  return answers.join("\n---\n\n");
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
    const { query, repoContext, owner, repo, tree, defaultBranch } =
      await req.json();

    const taskId = Math.random().toString(36).substring(7);
    activeJobs.set(taskId, { status: "pending" });

    const outDir = path.join(CONTEXT_DIR_PATH, owner, repo);
    const gapNBPath = path.join(outDir, "gap_filler_NB.txt");
    const insightsPath = path.join(outDir, "phase2_insights.txt");
    const queryPromptPath = path.join(outDir, "QUERY_PROMPT.txt");

    [gapNBPath, insightsPath, queryPromptPath].forEach((file) => {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    });

    const processJob = async () => {
      let repoLang: RepoLanguage | undefined;
      try {
        const setStatus = (
          msg: string,
          partial?: string,
          overrideProgress?: number,
        ) => {
          const job = activeJobs.get(taskId);
          if (job) {
            activeJobs.set(taskId, {
              ...job,
              statusText: msg,
              partialResult: partial,
              progress: overrideProgress,
            });
          }
        };

        // ── First-run: fetch repo and build notebook folders ───────────────
        if (!fs.existsSync(outDir)) {
          fs.mkdirSync(outDir, { recursive: true });
          setStatus("Resolving repository tree...");

          const coreFiles = tree.filter((f: any) => {
            const pLower = f.path.toLowerCase();
            if (pLower.includes("node_modules/") || pLower.includes(".git/"))
              return false;
            if (
              pLower.includes("dist/") ||
              pLower.includes("build/") ||
              pLower.includes("out/")
            )
              return false;
            if (
              pLower.includes("__snapshots__") ||
              pLower.includes("fixtures/") ||
              pLower.endsWith(".snap")
            )
              return false;
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
              ".playwright-auth.json",
              "auth.json",
              ".gitignore",
              ".gitattributes",
              ".gitmodules",
              "package-lock.json",
              "yarn.lock",
              "pnpm-lock.yaml",
              "composer.lock",
              "Cargo.lock",
              "poetry.lock",
              "Gemfile.lock",
            ];
            return (
              !ignoredExtensions.some((ext) => pLower.endsWith(ext)) &&
              !ignoredNames.some((name) => pLower.endsWith(name))
            );
          });

          const contents = await fetchFileContents(
            owner,
            repo,
            coreFiles,
            defaultBranch || "main",
            setStatus,
          );

          const fileSet = new Set<string>(coreFiles.map((f: any) => f.path));

          const metadata = Array.from(contents.entries()).map(([p, c]) => {
            const analysis =
              c.length < 500000
                ? analyzeFile(p, c, fileSet)
                : { imports: [] as string[] };
            return { path: p, content: c, ...analysis };
          });

          const importGraph: Record<
            string,
            { imports: string[]; imported_by: string[] }
          > = {};
          for (const file of metadata) {
            importGraph[file.path] = {
              imports: (file as any).imports || [],
              imported_by: [],
            };
          }
          for (const file in importGraph) {
            for (const dep of importGraph[file].imports) {
              if (importGraph[dep]) importGraph[dep].imported_by.push(file);
            }
          }

          setStatus("Chunking and structuring contexts...");
          const { lang: detectedLang } = await buildMasterContext(
            query,
            metadata,
            importGraph,
            repoContext,
            undefined,
            outDir,
            true,
          );
          repoLang = detectedLang;
        }

        const context = await getOrCreateContext();
        const manifestPath = path.join(outDir, "00_Root_Manifest.txt");
        const metaFilePath = path.join(outDir, "01_Meta.txt");

        // ── Score notebooks for this query ────────────────────────────────
        setStatus("Scoring notebooks for query relevance...");
        const notebookScores = scoreNotebooksForQuery(outDir, query);

        console.log("[SCORER] outDir:", outDir);
        console.log(
          "[SCORER] scores:",
          JSON.stringify(
            notebookScores.map((s) => ({
              name: s.notebookName,
              tier: s.tier,
              score: s.score,
            })),
          ),
        );

        const relevanceSection = buildQueryRelevanceSection(
          notebookScores,
          query,
        );
        const annotatedManifestPath = path.join(
          outDir,
          "00_Root_Manifest_Annotated.txt",
        );
        const rawManifest = fs.readFileSync(manifestPath, "utf-8");
        fs.writeFileSync(
          annotatedManifestPath,
          relevanceSection + "\n\n---\n\n" + rawManifest,
          "utf-8",
        );

        // ── Derive notebook plan from scorer ──────────────────────────────
        setStatus("Deriving notebook plan from relevance scores...");
        const notebookPlan = deriveNotebookPlan(notebookScores, query);

        if (!notebookPlan.notebooks || notebookPlan.notebooks.length === 0) {
          activeJobs.set(taskId, {
            status: "error",
            error:
              "Scorer found no relevant notebooks for this query. The repo may need to be re-fetched.",
          });
          return;
        }

        // ── Phase 2: query each selected notebook ─────────────────────────
        setStatus("Consulting NotebookLM...");
        const phase2Insights = await processNotebookPlan(
          context,
          notebookPlan,
          outDir,
          repo,
          repoLang,
          (msg, part, prog) => setStatus(msg, part, prog),
        );

        // ── Phase 3: final synthesis loop with gap fill ───────────────────
        setStatus("Running final phase 3 synthesis...");
        const finalInsightsPath = path.join(outDir, "phase2_insights.txt");
        const finalNotebookTitle = `@${repo} - [final answer]`;
        const MAX_GAP_FILLS = 3;
        let hasGapFilled = false;
        let currentInsights = phase2Insights;
        const filledSymbols = new Set<string>();

        const roadmapPath = path.join(outDir, "graph.json");
        let roadmapHeader = "";
        try {
          if (fs.existsSync(roadmapPath)) {
            const graphData = JSON.parse(fs.readFileSync(roadmapPath, "utf-8"));
            const entries = Object.entries(graphData) as [
              string,
              { imports: string[]; imported_by: string[] },
            ][];

            const entryPoints = entries
              .filter(([, info]) => info.imported_by.length === 0)
              .map(([p]) => p)
              .slice(0, 5);

            const sinks = entries
              .filter(([, info]) => info.imports.length === 0)
              .map(([p]) => p)
              .slice(0, 5);

            const hubFiles = entries
              .sort(
                ([, a], [, b]) => b.imported_by.length - a.imported_by.length,
              )
              .slice(0, 5)
              .map(
                ([p, info]) => `${p} (${info.imported_by.length} consumers)`,
              );

            roadmapHeader = [
              `### SYSTEM ROADMAP`,
              ``,
              `**Primary Entry Points (no upstream imports):** ${entryPoints.join(", ") || "none detected"}`,
              `**Terminal Sinks (no imports):** ${sinks.join(", ") || "none detected"}`,
              `**Most-Consumed Hub Files:** ${hubFiles.join("; ") || "none detected"}`,
              `**Total files in dependency graph:** ${entries.length}`,
              `(Full bidirectional graph available in graph.json and 00_Root_Manifest.txt)`,
              ``,
              `---`,
              ``,
            ].join("\n");
          }
        } catch (_) {}

        if (fs.existsSync(finalInsightsPath)) fs.unlinkSync(finalInsightsPath);
        fs.writeFileSync(
          finalInsightsPath,
          roadmapHeader + currentInsights,
          "utf-8",
        );

        for (let attempts = 0; attempts <= MAX_GAP_FILLS; attempts++) {
          const sourceFileRegex = /file_\d{3}_NB\d+\.txt/g;
          const matches = [...currentInsights.matchAll(sourceFileRegex)];
          const uniqueSourceFiles = Array.from(
            new Set(matches.map((m) => m[0])),
          );

          const finalPhaseFiles: string[] = [];
          for (const fileName of uniqueSourceFiles) {
            const nbMatch = fileName.match(/_NB(\d+)\.txt$/);
            if (nbMatch) {
              const nbNum = parseInt(nbMatch[1], 10);
              const folderName = `notebook_${String(nbNum).padStart(2, "0")}`;
              const filePath = path.join(outDir, folderName, fileName);
              if (fs.existsSync(filePath)) finalPhaseFiles.push(filePath);
            }
          }

          // [PINNING] Also include pinned source files from ALL notebooks in the plan,
          // but ONLY for the final phase answer. Convert to .txt if unsupported.
          const sourceMirrorDir = path.join(outDir, "source_mirror");
          if (fs.existsSync(sourceMirrorDir)) {
            const txtPinnedDir = path.join(outDir, "txt_pinned");
            if (!fs.existsSync(txtPinnedDir)) {
              fs.mkdirSync(txtPinnedDir, { recursive: true });
            }

            const pinnedSet = new Set<string>();
            for (const nb of notebookPlan.notebooks) {
              for (const coveredFile of nb.covers ?? []) {
                const mirrorPath = path.join(sourceMirrorDir, coveredFile);
                if (fs.existsSync(mirrorPath) && !pinnedSet.has(mirrorPath)) {
                  if (fs.statSync(mirrorPath).isDirectory()) continue;
                  const ext = path.extname(coveredFile).toLowerCase();
                  if (SUPPORTED_EXTENSIONS.has(ext)) {
                    finalPhaseFiles.push(mirrorPath);
                    console.log(
                      `[NOTEBOOK-FINAL] Pinning source mirror file: ${coveredFile}`,
                    );
                  } else {
                    const safeName = coveredFile.replace(/[\/\\]/g, "_");
                    const txtPath = path.join(txtPinnedDir, `${safeName}.txt`);
                    if (!fs.existsSync(txtPath)) {
                      fs.copyFileSync(mirrorPath, txtPath);
                    }
                    finalPhaseFiles.push(txtPath);
                    console.log(
                      `[NOTEBOOK-FINAL] Pinning source mirror file (converted to .txt): ${coveredFile} -> ${path.basename(txtPath)}`,
                    );
                  }
                  pinnedSet.add(mirrorPath);
                }
              }
            }
          }
          finalPhaseFiles.push(finalInsightsPath);
          if (fs.existsSync(gapNBPath)) finalPhaseFiles.push(gapNBPath);
          if (notebookPlan.include_meta && fs.existsSync(metaFilePath)) {
            finalPhaseFiles.push(metaFilePath);
          }

          const finalPhasePrompt = getFinalPhasePrompt(query, hasGapFilled);
          fs.writeFileSync(queryPromptPath, finalPhasePrompt, "utf-8");
          finalPhaseFiles.unshift(queryPromptPath);

          const chatTrigger =
            "Execute the full instructions from QUERY_PROMPT.txt. Output JSON only.";

          let page = context
            .pages()
            .find((p: any) => p.url()?.includes("notebooklm.google.com"));
          if (!page) page = await context.newPage();

          const structuralJsonResult = await automateNotebookLM(
            page,
            finalPhaseFiles,
            chatTrigger,
            finalNotebookTitle,
            setStatus,
            true,
            [finalInsightsPath, gapNBPath, queryPromptPath],
          );

          let parsedGap: MissingContextResult | null = null;
          let parsedPathA: FinalPhaseResult | null = null;
          try {
            let jsonString = structuralJsonResult
              .replace(/```(?:json)?\s*/gi, "")
              .replace(/```/g, "")
              .trim();
            const start = jsonString.indexOf("{");
            const end = jsonString.lastIndexOf("}");
            if (start !== -1 && end !== -1 && end > start) {
              const cleanedJson = jsonString
                .slice(start, end + 1)
                .replace(/[\x00-\x1F]+/g, " ");
              const resultJson = JSON.parse(cleanedJson);

              if (resultJson.status === "MISSING_CONTEXT") {
                parsedGap = resultJson as MissingContextResult;
              } else if (
                resultJson.files ||
                resultJson.call_chains ||
                resultJson.intent === "FIX"
              ) {
                parsedPathA = resultJson as FinalPhaseResult;

                if (resultJson.intent === "FIX") {
                  setStatus("Building precise code context for Deepseek...");

                  const rootManifestContent = fs.existsSync(manifestPath)
                    ? fs.readFileSync(manifestPath, "utf-8")
                    : "// [WARNING] Root manifest not found.";

                  const dsPromptString = getDeepseekCodingPrompt({
                    task: resultJson.task || "",
                    focusAreas: resultJson.target_areas || [],
                    userQuery: query,
                    strategy: resultJson.extraction_strategy,
                    failureFocus: resultJson.failure_focus || [],
                  });

                  let deepPage = context
                    .pages()
                    .find((p: any) => p.url()?.includes("chat.deepseek.com"));
                  if (!deepPage) deepPage = await context.newPage();

                  const MAX_DS_GAP_FILLS = 2;
                  const dsFilledSymbols = new Set<string>();
                  let currentPathBJson = resultJson;

                  for (
                    let dsAttempt = 0;
                    dsAttempt <= MAX_DS_GAP_FILLS;
                    dsAttempt++
                  ) {
                    const { contextDir: dsContextDir } = buildDeepseekContext(
                      currentPathBJson,
                      outDir,
                    );

                    setStatus(
                      dsAttempt === 0
                        ? "Routing Path B payload to Deepseek..."
                        : `Deepseek gap fill attempt ${dsAttempt} — retrying with enriched context...`,
                    );

                    let dsRaw = "";
                    try {
                      dsRaw = await askDeepseek(
                        deepPage,
                        dsPromptString,
                        rootManifestContent,
                        dsContextDir,
                        (msg, partial, prog) =>
                          setStatus(`[Deepseek] ${msg}`, partial, prog),
                        outDir,
                      );
                    } catch (dsErr: any) {
                      console.warn("[Deepseek] Failed:", dsErr.message);
                      activeJobs.set(taskId, {
                        status: "error",
                        error: dsErr.message,
                      });
                      return;
                    }

                    // ── Check if DeepSeek needs more context ───────────────
                    let dsNeedsMore = false;
                    try {
                      const cleanedDs = dsRaw
                        .replace(/```(?:json)?\s*/gi, "")
                        .replace(/```/g, "")
                        .trim();
                      const dsStart = cleanedDs.indexOf("{");
                      const dsEnd = cleanedDs.lastIndexOf("}");
                      if (dsStart !== -1 && dsEnd !== -1 && dsEnd > dsStart) {
                        const dsParsed = JSON.parse(
                          cleanedDs.slice(dsStart, dsEnd + 1),
                        );

                        if (
                          dsParsed.status === "NEED_MORE_CONTEXT" &&
                          Array.isArray(dsParsed.missing_symbols) &&
                          dsParsed.missing_symbols.length > 0 &&
                          dsAttempt < MAX_DS_GAP_FILLS
                        ) {
                          dsNeedsMore = true;
                          const symbolsToFetch: Array<{
                            name: string;
                            source_file: string;
                          }> = dsParsed.missing_symbols;

                          setStatus(
                            `Deepseek requested: ${symbolsToFetch.map((s: any) => s.name).join(", ")} — fetching...`,
                          );

                          // ── Stub detection helpers ────────────────────────────────────────────
                          const STUB_SIGNALS = [
                            /throw new Error\(['"`]Not implemented/i,
                            /\/\/ stub/i,
                            /\/\/ not implemented/i,
                            /^\s*\/\/ \[GAP FILE TOO LARGE/m,
                            /^\s*\/\/ \[WHOLE-FILE FALLBACK\]/m,
                          ];

                          function isStubContent(content: string): boolean {
                            // If the meaningful non-comment, non-whitespace lines are very few
                            const meaningfulLines = content
                              .split("\n")
                              .filter(
                                (l) => l.trim() && !l.trim().startsWith("//"),
                              );
                            if (meaningfulLines.length < 5) return true;
                            return STUB_SIGNALS.some((re) => re.test(content));
                          }

                          // ── Accumulate gap bundles, skip stubs ────────────────────────────────
                          const gapBundles: string[] = [];
                          const skippedStubs: string[] = [];

                          for (const sym of symbolsToFetch) {
                            if (
                              sym.name.includes("/") ||
                              sym.name.match(/\.[jt]sx?$/)
                            ) {
                              const baseName = path
                                .basename(sym.name)
                                .replace(/\.[jt]sx?$/, "");
                              sym.name =
                                baseName.charAt(0).toUpperCase() +
                                baseName.slice(1);
                              console.warn(
                                `[DS-GAP] Normalized path-as-name → "${sym.name}"`,
                              );
                            }
                            const symKey =
                              `${sym.name}|${sym.source_file}`.toLowerCase();
                            if (dsFilledSymbols.has(symKey)) {
                              console.warn(
                                `[DS-GAP] Already filled "${sym.name}" — skipping.`,
                              );
                              continue;
                            }
                            dsFilledSymbols.add(symKey);

                            console.log("[DS-GAP] outDir:", outDir);
                            console.log("[DS-GAP] sym.name:", sym.name);
                            console.log(
                              "[DS-GAP] sym.source_file:",
                              sym.source_file,
                            );
                            console.log(
                              "[DS-GAP] source_mirror exists:",
                              fs.existsSync(path.join(outDir, "source_mirror")),
                            );
                            console.log(
                              "[DS-GAP] target file exists:",
                              fs.existsSync(
                                path.join(
                                  outDir,
                                  "source_mirror",
                                  sym.source_file,
                                ),
                              ),
                            );

                            const { gapAnalysisBundle } =
                              generateGapFillerNotebook(
                                outDir,
                                sym.name,
                                sym.source_file,
                                [],
                                sym.source_file,
                                currentPathBJson.context_files || [],
                              );

                            if (!gapAnalysisBundle) {
                              console.warn(
                                `[DS-GAP] No bundle generated for "${sym.name}".`,
                              );
                              continue;
                            }

                            if (isStubContent(gapAnalysisBundle)) {
                              console.warn(
                                `[DS-GAP] Stub detected for "${sym.name}" in ${sym.source_file} — skipping to avoid loop.`,
                              );
                              skippedStubs.push(
                                `${sym.name} (${sym.source_file}): stub or not implemented`,
                              );
                              continue;
                            }

                            gapBundles.push(
                              `// Gap-filled: ${sym.name} from ${sym.source_file}\n\n${gapAnalysisBundle}`,
                            );
                            console.log(
                              `[DS-GAP] Accepted gap bundle for "${sym.name}"`,
                            );
                          }

                          // ── If everything was stubs, abort the gap fill loop ─────────────────
                          if (gapBundles.length === 0) {
                            console.warn(
                              `[DS-GAP] All requested symbols were stubs or already filled. Forcing final output.`,
                            );
                            dsNeedsMore = false;

                            const stubNote =
                              skippedStubs.length > 0
                                ? `\n\n// [GAP-FILL ABORTED] The following symbols resolved to stubs (not implemented) and cannot be filled:\n` +
                                  skippedStubs
                                    .map((s) => `// - ${s}`)
                                    .join("\n")
                                : "";

                            // Append stub note to context.js so DeepSeek sees why we stopped
                            const ctxPath = path.join(
                              outDir,
                              "deepseek_context",
                              "context.js",
                            );
                            if (fs.existsSync(ctxPath)) {
                              fs.appendFileSync(ctxPath, stubNote, "utf-8");
                            }

                            // Don't loop again — fall through to final output with what we have
                            activeJobs.set(taskId, {
                              status: "done",
                              result: dsRaw,
                              answerSource: "final",
                            });
                            return;
                          }

                          // ── Write gap_filler.txt into deepseek_context/ ───────────────────────
                          const dsContextDir = path.join(
                            outDir,
                            "deepseek_context",
                          );
                          fs.mkdirSync(dsContextDir, { recursive: true });

                          const gapFillerPath = path.join(
                            dsContextDir,
                            "gap_filler.txt",
                          );
                          const existingGapContent = fs.existsSync(
                            gapFillerPath,
                          )
                            ? fs.readFileSync(gapFillerPath, "utf-8") + "\n\n"
                            : "";

                          fs.writeFileSync(
                            gapFillerPath,
                            existingGapContent + gapBundles.join("\n\n---\n\n"),
                            "utf-8",
                          );
                          console.log(
                            `[DS-GAP] Wrote gap_filler.txt to ${dsContextDir}`,
                          );

                          // ── Update context_files for next round ──────────────────────────────
                          const newContextFiles = [
                            ...new Set([
                              ...(currentPathBJson.context_files || []),
                              ...symbolsToFetch
                                .map((s: any) => s.source_file)
                                .filter(Boolean),
                            ]),
                          ];
                          currentPathBJson = {
                            ...currentPathBJson,
                            context_files: newContextFiles,
                          };
                        }
                      }
                    } catch {
                      // Not JSON or not NEED_MORE_CONTEXT — treat as final output
                    }

                    if (!dsNeedsMore) {
                      activeJobs.set(taskId, {
                        status: "done",
                        result:
                          typeof dsRaw === "string"
                            ? dsRaw
                            : JSON.stringify(dsRaw, null, 2),
                        answerSource: "final",
                      });
                      return;
                    }
                  }

                  // Exhausted DeepSeek gap fill attempts
                  activeJobs.set(taskId, {
                    status: "done",
                    result:
                      "DeepSeek requested more context but gap fill limit was reached. Check deepseek_context/ folder.",
                    answerSource: "final",
                  });
                  return;
                }

                if (parsedPathA.coverage_gaps?.length > 0) {
                  console.info(
                    `[FINAL-PHASE] PATH A coverage gaps (non-breaking):`,
                    parsedPathA.coverage_gaps,
                  );
                }
              }
            }
          } catch (parseErr: any) {
            console.warn(
              `[FINAL-PHASE] JSON parse failed on attempt ${attempts}:`,
              parseErr.message,
            );
          }

          if (!parsedGap || attempts >= MAX_GAP_FILLS) {
            let finalResult = structuralJsonResult;

            try {
              if (structuralJsonResult.trim().startsWith("{")) {
                setStatus(
                  "Requesting Staff-Level Engineering Manual from ChatGPT...",
                );
                const chatgptPrompt = getStaffEngineerPrompt(
                  query,
                  parsedPathA
                    ? JSON.stringify(parsedPathA, null, 2)
                    : structuralJsonResult,
                );

                let chatPage = context
                  .pages()
                  .find((p: any) => p.url()?.includes("chatgpt.com"));
                if (!chatPage) chatPage = await context.newPage();

                const manual = await automateChatGPT(
                  chatPage,
                  chatgptPrompt,
                  (msg) => setStatus(`[ChatGPT] ${msg}`),
                );
                finalResult = manual;
              }
            } catch (chatgptErr: any) {
              console.warn(
                "[ChatGPT Automator] Failed to generate manual:",
                chatgptErr.message,
              );
            }

            activeJobs.set(taskId, {
              status: "done",
              result: finalResult,
              answerSource: "final",
            });
            return;
          }

          // ── Gap fill ───────────────────────────────────────────────────
          const { target_symbol, search_keywords, last_known_node } =
            parsedGap.missing_link;

          const target_file =
            last_known_node ||
            (parsedGap.missing_link as any).target_file ||
            "";

          const gapKeywords: string[] = Array.isArray(search_keywords)
            ? search_keywords
            : [];

          setStatus(
            `Gap detected: ${
              Array.isArray(target_symbol)
                ? target_symbol.join(", ")
                : target_symbol
            }${last_known_node ? ` (last known node: ${last_known_node})` : ""}. Scouting sources...`,
          );

          const symbolList: string[] = Array.isArray(target_symbol)
            ? target_symbol
            : (target_symbol || "")
                .toString()
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean);

          const gapKey =
            symbolList
              .map((s) => s.trim().toLowerCase())
              .sort()
              .join("|") +
            "|" +
            (target_file || "").toLowerCase();

          if (filledSymbols.has(gapKey)) {
            console.warn(
              `[GAP-FILLER] Symbol "${target_symbol}" was already gap-filled. Forcing synthesis.`,
            );
            let finalResult = currentInsights;
            try {
              const chatgptPrompt = getStaffEngineerPrompt(
                query,
                currentInsights,
              );
              let chatPage = context
                .pages()
                .find((p: any) => p.url()?.includes("chatgpt.com"));
              if (!chatPage) chatPage = await context.newPage();
              finalResult = await automateChatGPT(
                chatPage,
                chatgptPrompt,
                (msg) => setStatus(`[ChatGPT] ${msg}`),
              );
            } catch {
              /* use currentInsights as fallback */
            }
            activeJobs.set(taskId, {
              status: "done",
              result: finalResult,
              answerSource: "chatgpt",
            });
            return;
          }
          filledSymbols.add(gapKey);

          const mergedSourceFiles = new Set<string>();
          let mergedBundle = "";

          const plannerContextFiles: string[] = (
            notebookPlan.notebooks ?? []
          ).flatMap((nb) => nb.covers ?? []);

          for (const sym of symbolList) {
            const { gapSourceFiles: sf, gapAnalysisBundle: ab } =
              generateGapFillerNotebook(
                outDir,
                sym.toString(),
                target_file.toString(),
                gapKeywords,
                last_known_node,
                plannerContextFiles,
              );
            sf.forEach((f) => mergedSourceFiles.add(f));
            if (ab) mergedBundle += ab + "\n\n";
          }

          const gapSourceFiles = Array.from(mergedSourceFiles);
          const gapAnalysisBundle = mergedBundle.trim();

          if (gapSourceFiles.length === 0) {
            console.warn(
              `[GAP-FILLER] No source files found for "${target_symbol}". Falling back to ChatGPT.`,
            );
            let finalResult = currentInsights;
            try {
              setStatus(
                "Gap unresolvable — synthesizing from phase2 insights...",
              );
              const chatgptPrompt = getStaffEngineerPrompt(
                query,
                currentInsights,
              );
              let chatPage = context
                .pages()
                .find((p: any) => p.url()?.includes("chatgpt.com"));
              if (!chatPage) chatPage = await context.newPage();
              const manual = await automateChatGPT(
                chatPage,
                chatgptPrompt,
                (msg) => setStatus(`[ChatGPT] ${msg}`),
              );
              finalResult = manual;
            } catch (chatgptErr: any) {
              console.warn("[ChatGPT Fallback] Failed:", chatgptErr.message);
            }
            activeJobs.set(taskId, {
              status: "done",
              result: finalResult,
              answerSource: "chatgpt",
            });
            return;
          }

          if (fs.existsSync(gapNBPath)) {
            const existingGap = fs.readFileSync(gapNBPath, "utf-8");
            fs.writeFileSync(
              gapNBPath,
              existingGap + "\n\n" + gapAnalysisBundle,
              "utf-8",
            );
          } else {
            fs.writeFileSync(gapNBPath, gapAnalysisBundle, "utf-8");
          }

          const filesList = gapSourceFiles
            .map((f) => path.basename(f))
            .join(", ");
          const breadcrumb = `\n\n### [GAP-FILLER ATTEMPT ${attempts + 1}]\n- **Target**: ${target_symbol}\n- **Status**: Full source extracted to gap_filler_NB.txt.\n- **Resolved Files**: ${filesList}.\n- **IMPORTANT FOR AI**: The implementation of \`${target_symbol}\` is now in gap_filler_NB.txt. Do NOT declare a gap for this symbol again.\n`;

          currentInsights =
            fs.readFileSync(finalInsightsPath, "utf-8") + breadcrumb;
          fs.writeFileSync(finalInsightsPath, currentInsights, "utf-8");
          hasGapFilled = true;
        }
      } catch (err: any) {
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
