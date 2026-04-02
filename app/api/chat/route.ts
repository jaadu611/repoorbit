import { buildMasterContext } from "@/lib/contextBuilder";
import path from "path";
import fs from "fs";
import { analyzeFile, fetchFileContents } from "@/lib/github";
import {
  automateNotebookLM,
  parseNotebookPlan,
} from "@/lib/notebooklmAutomator";
import { automateChatGPT } from "@/lib/chatgptAutomator";
import { getOrCreateContext } from "@/lib/browser";
import { generateGapFillerNotebook } from "@/lib/gapScout";
import {
  getNotebooklmPlannerPrompt,
  getFinalPhasePrompt,
  getArchitectPrompt,
  getStaffEngineerPrompt,
} from "@/lib/prompts";
import { NextResponse } from "next/server";
import { BrowserContext } from "playwright";

import { JobStatus, NotebookPlan } from "@/lib/types";

export const CONTEXT_DIR_PATH = "/tmp/notebooklm_sources";
export const NOTEBOOKLM_URL = "https://notebooklm.google.com/";

const GLOBAL_JOBS_KEY = Symbol.for("repoorbit.playwright.jobs");
export const activeJobs: Map<string, JobStatus> = 
  (global as any)[GLOBAL_JOBS_KEY] || new Map();
(global as any)[GLOBAL_JOBS_KEY] = activeJobs;

async function processNotebookPlan(
  context: BrowserContext,
  plan: NotebookPlan,
  baseDir: string,
  repoName: string,
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
    const notebookFolder = path.join(baseDir, nb.name);

    onStatus?.(
      `Querying ${nb.name} (${i + 1}/${total})...`,
      undefined,
      Math.round(((i + 1) / total) * 100),
    );

    if (!fs.existsSync(notebookFolder)) {
      answers.push(`### ${nb.name}\n[ERROR] Folder does not exist.\n`);
      continue;
    }

    const allTxts = fs
      .readdirSync(notebookFolder)
      .filter((f) => f.endsWith(".txt"))
      .sort();

    const manifestFile = allTxts.find((f) => f === "00_manifest.txt");
    const sourceFiles = allTxts.filter((f) => f !== "00_manifest.txt");
    const orderedFiles = [
      ...sourceFiles,
      ...(manifestFile ? [manifestFile] : []),
    ].map((f) => path.join(notebookFolder, f));

    if (orderedFiles.length === 0) {
      answers.push(`### ${nb.name}\n[ERROR] No source files found.\n`);
      continue;
    }

    const notebookTitle = `@${repoName} - ${nb.name}`;

    let answer = "";
    try {
      const architectPrompt = getArchitectPrompt(nb.sub_question);
      answer = await automateNotebookLM(
        page,
        orderedFiles,
        architectPrompt,
        notebookTitle,
        onStatus,
      );
    } catch (err: any) {
      answer = `[Error] ${err.message}`;
    }

    answers.push(`### ${nb.name}\n\n${answer}\n`);

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

export async function POST(req: Request) {
  try {
    const { query, repoContext, owner, repo, tree, defaultBranch } =
      await req.json();
    const taskId = Math.random().toString(36).substring(7);
    activeJobs.set(taskId, { status: "pending" });

    const outDir = path.join(CONTEXT_DIR_PATH, owner, repo);
    const gapNBPath = path.join(outDir, "gap_filler_NB.txt");

    const processJob = async () => {
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

          const MAX_FILES = 3000;
          const sortedFiles = coreFiles.slice(0, MAX_FILES);

          const contents = await fetchFileContents(
            owner,
            repo,
            sortedFiles,
            defaultBranch || "main",
            setStatus,
          );

          const fileSet = new Set<string>(sortedFiles.map((f: any) => f.path));

          const metadata = Array.from(contents.entries()).map(([p, c]) => {
            // Skip analysis for very large files to avoid RangeError/timeouts
            const analysis =
              c.length < 500000
                ? analyzeFile(p, c, fileSet)
                : { imports: [] as string[] };
            return {
              path: p,
              content: c,
              ...analysis,
            };
          });

          // Build bidirectional import graph
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
              if (importGraph[dep]) {
                importGraph[dep].imported_by.push(file);
              }
            }
          }

          setStatus("Chunking and structuring contexts...");
          await buildMasterContext(
            query,
            metadata,
            importGraph,
            repoContext,
            undefined,
            outDir,
            true,
          );
        }

        setStatus("Consulting NotebookLM...");
        const context = await getOrCreateContext();
        const manifestPath = path.join(outDir, "00_Root_Manifest.txt");
        const metaFilePath = path.join(outDir, "01_Meta.txt");

        let plannerPage = context
          .pages()
          .find((p: any) => p.url()?.includes("notebooklm.google.com"));
        if (!plannerPage) plannerPage = await context.newPage();

        const plannerPromptText = getNotebooklmPlannerPrompt(query);
        const rawPlanString = await automateNotebookLM(
          plannerPage,
          [manifestPath, metaFilePath],
          plannerPromptText,
          `@${repo} - [Planner]`,
          setStatus,
        );
        const notebookPlan = parseNotebookPlan(rawPlanString);

        if (notebookPlan.direct_answer) {
          activeJobs.set(taskId, {
            status: "done",
            result: notebookPlan.direct_answer,
          });
          return;
        }

        const phase2Insights = await processNotebookPlan(
          context,
          notebookPlan,
          outDir,
          repo,
          setStatus,
        );

        setStatus("Running final phase 3 synthesis...");
        const insightsPath = path.join(outDir, "phase2_insights.txt");
        const finalNotebookTitle = `@${repo} - [final answer]`;
        const MAX_GAP_FILLS = 3;
        let hasGapFilled = false;
        let currentInsights = phase2Insights;

        const roadmapPath = path.join(outDir, "graph.json");
        let roadmapHeader = "";
        try {
          if (fs.existsSync(roadmapPath)) {
            const graphData = JSON.parse(fs.readFileSync(roadmapPath, "utf-8"));
            const entryPoints = Object.keys(graphData)
              .filter(
                (p) =>
                  graphData[p] &&
                  graphData[p].imported_by &&
                  graphData[p].imported_by.length === 0,
              )
              .slice(0, 5);
            roadmapHeader = `### SYSTEM ROADMAP\n\nPrimary Entry Points: ${entryPoints.join(", ")}\n(Full bidirectional graph available in 01_Meta.txt and graph.json)\n\n---\n\n`;
          }
        } catch (_) {}

        fs.writeFileSync(insightsPath, roadmapHeader + currentInsights, "utf-8");

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
          finalPhaseFiles.push(insightsPath);
          if (fs.existsSync(gapNBPath)) finalPhaseFiles.push(gapNBPath);

          const finalPrompt = getFinalPhasePrompt(query, hasGapFilled);
          let page = context
            .pages()
            .find((p: any) => p.url()?.includes("notebooklm.google.com"));
          if (!page) page = await context.newPage();

          const structuralJsonResult = await automateNotebookLM(
            page,
            finalPhaseFiles,
            finalPrompt,
            finalNotebookTitle,
            setStatus,
            true,
            hasGapFilled ? [insightsPath, gapNBPath] : undefined,
          );

          let parsedGap: any = null;
          try {
            let jsonString = structuralJsonResult
              .replace(/```(?:json)?\s*/gi, "")
              .replace(/```/g, "")
              .trim();
            const start = jsonString.indexOf("{");
            const end = jsonString.lastIndexOf("}");
            if (start !== -1 && end !== -1 && end > start) {
              const resultJson = JSON.parse(jsonString.slice(start, end + 1));
              if (resultJson.status === "MISSING_CONTEXT")
                parsedGap = resultJson;
            }
          } catch (_) {}

          if (!parsedGap || attempts >= MAX_GAP_FILLS) {
            let finalResult = structuralJsonResult;

            // Optional: Connect ChatGPT Automator for high-level architectural manual
            try {
              if (structuralJsonResult.trim().startsWith("{")) {
                setStatus("Requesting Staff-Level Engineering Manual from ChatGPT...");
                const chatgptPrompt = getStaffEngineerPrompt(query, structuralJsonResult);
                
                let chatPage = context.pages().find((p: any) => p.url()?.includes("chatgpt.com"));
                if (!chatPage) chatPage = await context.newPage();
                
                const manual = await automateChatGPT(chatPage, chatgptPrompt, (msg) => setStatus(`[ChatGPT] ${msg}`));
                finalResult = `## 📐 Staff-Level Engineering Manual\n\n${manual}\n\n---\n\n## 🛠️ Structural JSON Context (Path A)\n\n${structuralJsonResult}`;
              }
            } catch (chatgptErr: any) {
              console.warn("[ChatGPT Automator] Failed to generate manual:", chatgptErr.message);
              // Fallback to original result if ChatGPT fails
            }

            activeJobs.set(taskId, { status: "done", result: finalResult });
            return;
          }

          const { target_symbol, target_file } = parsedGap.missing_link;
          setStatus(`Gap detected: ${target_symbol}. Scouting sources...`);

          const { gapSourceFiles, gapAnalysisBundle } =
            generateGapFillerNotebook(outDir, target_symbol, target_file);
          if (gapSourceFiles.length === 0) {
            activeJobs.set(taskId, { status: "done", result: structuralJsonResult });
            return;
          }

          fs.writeFileSync(gapNBPath, gapAnalysisBundle, "utf-8");
          const filesList = gapSourceFiles
            .map((f) => path.basename(f))
            .join(", ");
          const breadcrumb = `\n\n### [GAP-FILLER ATTEMPT]\n- **Target**: ${target_symbol}\n- **Status**: Full source extracted to gap_filler_NB.txt.\n- **Summary**: Identified patterns in ${filesList}.\n`;

          currentInsights = fs.readFileSync(insightsPath, "utf-8") + breadcrumb;
          fs.writeFileSync(insightsPath, currentInsights, "utf-8");
          hasGapFilled = true;
        }
      } catch (err: any) {
        activeJobs.set(taskId, { status: "error", error: err.message });
      }
    };

    processJob().catch(() => {});
    return NextResponse.json({ success: true, taskId });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
