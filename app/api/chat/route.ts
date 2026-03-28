import { NextResponse } from "next/server";
import { buildMasterContext } from "@/lib/contextBuilder";
import { chromium, BrowserContext, Page } from "playwright";
import path from "path";
import fs from "fs";
import { analyzeFile } from "@/lib/github";
import { automateNotebookLM } from "@/lib/notebooklmAutomator";
import { runGeminiRouter } from "@/lib/Geminiautomator";

const CONTEXT_DIR_PATH = "/tmp/notebooklm_sources";
const NOTEBOOKLM_URL = "https://notebooklm.google.com/";

const GLOBAL_JOBS_KEY = Symbol.for("repoorbit.playwright.jobs");
const activeJobs: Map<
  string,
  {
    status: "pending" | "done" | "error";
    result?: string;
    partialResult?: string;
    error?: string;
    statusText?: string;
    progress?: number;
  }
> = (global as any)[GLOBAL_JOBS_KEY] || new Map();
(global as any)[GLOBAL_JOBS_KEY] = activeJobs;

const GLOBAL_CONTEXT_KEY = Symbol.for("repoorbit.playwright.context");
let sharedContext: BrowserContext | null =
  (global as any)[GLOBAL_CONTEXT_KEY] || null;

async function getOrCreateContext(): Promise<BrowserContext> {
  if (sharedContext) {
    try {
      const pages = sharedContext.pages();
      if (pages.length > 0) {
        await pages[0].evaluate(() => 1);
        return sharedContext;
      }
    } catch {
      sharedContext = null;
    }
  }
  try {
    const browser = await chromium.connectOverCDP("http://localhost:9222");
    sharedContext = browser.contexts()[0];
    (global as any)[GLOBAL_CONTEXT_KEY] = sharedContext;
    return sharedContext;
  } catch (err: any) {
    console.warn(
      "Could not connect to CDP on 9222, falling back to new browser: ",
      err.message,
    );
    const profilePath = path.join(process.cwd(), ".notebooklm-profile");
    sharedContext = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    (global as any)[GLOBAL_CONTEXT_KEY] = sharedContext;
    return sharedContext;
  }
}

async function fetchFileContents(
  owner: string,
  repo: string,
  files: any[],
  ref: string,
  onStatus?: (msg: string, partial?: string, progress?: number) => void,
) {
  const result = new Map<string, string>();
  const CHUNK_SIZE = 100;
  const CONCURRENCY = 50;

  const token =
    process.env.GITHUB_TOKEN || process.env.NEXT_PUBLIC_GITHUB_TOKEN;

  const allChunks: any[][] = [];
  for (let i = 0; i < files.length; i += CHUNK_SIZE) {
    allChunks.push(files.slice(i, i + CHUNK_SIZE));
  }

  for (
    let blockIndex = 0;
    blockIndex < allChunks.length;
    blockIndex += CONCURRENCY
  ) {
    const batchedChunks = allChunks.slice(blockIndex, blockIndex + CONCURRENCY);
    const upperLimit = Math.min(blockIndex + CONCURRENCY, allChunks.length);
    const filesFetched = Math.min(upperLimit * CHUNK_SIZE, files.length);

    console.log(
      `[GitHub API] Fetching chunks ${blockIndex + 1} to ${upperLimit} of ${allChunks.length}...`,
    );
    onStatus?.(
      `Syncing source... (${filesFetched}/${files.length})`,
      undefined,
      Math.round((filesFetched / files.length) * 100),
    );

    await Promise.all(
      batchedChunks.map(async (chunk) => {
        const fields = chunk
          .map(
            (f, idx) =>
              `f${idx}: object(expression: "${ref}:${f.path}") { ... on Blob { text } }`,
          )
          .join("\n");

        const query = `{ repository(owner: "${owner}", name: "${repo}") { ${fields} } }`;

        try {
          const res = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ query }),
          });

          if (!res.ok) {
            console.warn(`[GitHub API] Chunk failed: ${res.statusText}`);
            return;
          }

          const { data } = await res.json();
          if (data?.repository) {
            chunk.forEach((f, idx) => {
              if (data.repository[`f${idx}`]?.text) {
                result.set(f.path, data.repository[`f${idx}`].text);
              }
            });
          }
        } catch (err: any) {
          console.error(`[GitHub API] GraphQL request failed: ${err.message}`);
        }
      }),
    );
  }

  return result;
}

// ─── Per-notebook progress tracker ───────────────────────────────────────────
// Keeps the last known progress for each notebook so that averaging never
// pulls a live notebook down to 0 just because another notebook hasn't
// reported yet.

class NotebookProgressTracker {
  private statuses = new Map<number, { text: string; progress: number }>();

  update(nb: number, text: string, progress?: number) {
    const prev = this.statuses.get(nb);
    this.statuses.set(nb, {
      text,
      // Keep previous progress value if the new call doesn't supply one
      progress: progress ?? prev?.progress ?? 0,
    });
  }

  combinedStatusText(): string {
    return Array.from(this.statuses.entries())
      .sort(([a], [b]) => a - b)
      .map(([nb, s]) => `NB${nb}: ${s.text} (${s.progress}%)`)
      .join(" | ");
  }

  averageProgress(): number {
    if (this.statuses.size === 0) return 0;
    const total = Array.from(this.statuses.values()).reduce(
      (acc, s) => acc + s.progress,
      0,
    );
    return Math.round(total / this.statuses.size);
  }
}

async function uploadAndGetResult(
  context: BrowserContext,
  outputDir: string,
  query: string,
  taskId: string,
  repoName: string,
) {
  try {
    const tracker = new NotebookProgressTracker();

    const onStatus = (msg: string, partial?: string, progress?: number) => {
      const job = activeJobs.get(taskId);
      if (!job) return;

      const nbMatch = msg.match(/^\[NB(\d+)\] (.*)/);
      if (nbMatch) {
        const nbNum = parseInt(nbMatch[1], 10);
        const rest = nbMatch[2];
        tracker.update(nbNum, rest, progress);

        activeJobs.set(taskId, {
          ...job,
          statusText: tracker.combinedStatusText(),
          partialResult: partial ?? job.partialResult, // never overwrite with undefined
          progress: tracker.averageProgress(),
        });
      } else {
        // Global (non-per-notebook) status: preserve current progress unless
        // a new value is explicitly provided.
        activeJobs.set(taskId, {
          ...job,
          statusText: msg,
          partialResult: partial ?? job.partialResult,
          ...(progress !== undefined ? { progress } : {}),
        });
      }
    };

    // 1. Pre-warm NotebookLM tabs in parallel with Gemini routing
    console.log(
      `[AIAgent] Pre-warming 3 NotebookLM tabs for task ${taskId}...`,
    );
    const preWarmTask = Promise.all(
      [1, 2, 3].map(async () => {
        const p = await context.newPage();
        await p.goto(NOTEBOOKLM_URL, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        return p;
      }),
    );

    // 2. Run Gemini Router
    const routerPage = await context.newPage();
    const routerIndexPath = path.join(outputDir, "router_index.json");

    const geminiRoute = await runGeminiRouter(routerPage, {
      routerIndexPath,
      userQuery: query,
      onStatus: (msg) => onStatus(msg),
    });

    await routerPage.close().catch(() => {});

    // 3. Wait for pre-warming to complete
    const preWarmedPages = await preWarmTask;

    // 4. Run NotebookLM Automator
    const result = await automateNotebookLM(
      context,
      null,
      {},
      geminiRoute,
      repoName,
      outputDir,
      onStatus,
      preWarmedPages,
    );

    onStatus("Done", undefined, 100);
    activeJobs.set(taskId, { status: "done", result, progress: 100 });
  } catch (err: any) {
    console.error(`[AIAgent] Error in automation pipeline: ${err.message}`);
    activeJobs.set(taskId, { status: "error", error: err.message });
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const taskId = searchParams.get("taskId");
  return NextResponse.json(activeJobs.get(taskId!) || { status: "pending" });
}

export async function POST(req: Request) {
  try {
    const { query, repoContext, owner, repo, tree, defaultBranch } =
      await req.json();
    const taskId = Math.random().toString(36).substring(7);
    activeJobs.set(taskId, { status: "pending", progress: 0 });

    const outDir = path.join(CONTEXT_DIR_PATH, owner, repo);

    const processJob = async () => {
      try {
        // updateStatus never touches progress unless explicitly given one,
        // so the bar never jumps backwards to 0.
        const updateStatus = (
          msg: string,
          partial?: string,
          explicitProgress?: number,
        ) => {
          const job = activeJobs.get(taskId);
          if (!job) return;
          activeJobs.set(taskId, {
            ...job,
            statusText: msg,
            ...(partial !== undefined ? { partialResult: partial } : {}),
            ...(explicitProgress !== undefined
              ? { progress: explicitProgress }
              : {}),
          });
        };

        if (!fs.existsSync(outDir)) {
          fs.mkdirSync(outDir, { recursive: true });
          updateStatus("Resolving repository tree...", undefined, 0);

          const coreFiles = tree.filter((f: any) => {
            const p = f.path;
            const pLower = p.toLowerCase();

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
              "-lock.yaml",
              "package-lock.json",
              "yarn.lock",
              "pnpm-lock.yaml",
            ];
            if (ignoredExtensions.some((ext) => pLower.endsWith(ext)))
              return false;

            return true;
          });

          const contents = await fetchFileContents(
            owner,
            repo,
            coreFiles,
            defaultBranch || "main",
            updateStatus,
          );

          updateStatus("Building context graphs...");
          const metadata = Array.from(contents.entries()).map(([p, c]) => ({
            path: p,
            content: c,
            analysis: analyzeFile(p, c),
          }));

          updateStatus("Chunking and structuring contexts...");
          await buildMasterContext(
            query,
            metadata,
            {},
            repoContext,
            undefined,
            outDir,
            true,
          );
        }

        updateStatus("Booting headless LLM...");
        const context = await getOrCreateContext();
        await uploadAndGetResult(context, outDir, query, taskId, repo);
      } catch (err: any) {
        console.error(`[Background Job Error]: ${err.message}`);
        activeJobs.set(taskId, { status: "error", error: err.message });
      }
    };

    processJob().catch(console.error);
    return NextResponse.json({ success: true, taskId });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
