import { NextResponse } from "next/server";
import { buildMasterContext, buildFallbackContext } from "@/lib/contextBuilder";
import { chromium, BrowserContext, Page } from "playwright";
import path from "path";
import fs from "fs";
import { parseImports, analyzeFile } from "@/lib/github";
import { getArchitectPrompt } from "@/lib/prompts";
import { automateNotebookLM } from "@/lib/notebooklmAutomator";

const CONTEXT_DIR_PATH = "/tmp/notebooklm_sources";
const GEMINI_CONTEXT_PATH = "/tmp/contextForGemini.txt";
const NOTEBOOKLM_URL = "https://notebooklm.google.com/";
const token = (
  process.env.GITHUB_TOKEN ||
  process.env.NEXT_PUBLIC_GITHUB_TOKEN ||
  ""
)
  .trim()
  .replace(/^["']|["']$/g, "");

const GLOBAL_JOBS_KEY = Symbol.for("repoorbit.playwright.jobs");
const activeJobs: Map<
  string,
  {
    status: "pending" | "done" | "error";
    result?: string;
    error?: string;
    statusText?: string;
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
  const profilePath = path.join(process.cwd(), ".notebooklm-profile");
  sharedContext = await chromium.launchPersistentContext(profilePath, { 
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"]
  });
  (global as any)[GLOBAL_CONTEXT_KEY] = sharedContext;
  return sharedContext;
}

async function fetchFileContents(
  owner: string,
  repo: string,
  files: any[],
  ref: string,
  onStatus?: (msg: string) => void,
) {
  const result = new Map<string, string>();
  const CHUNK_SIZE = 50; 
  const CONCURRENCY = 5; 

  let token = process.env.GITHUB_TOKEN || process.env.NEXT_PUBLIC_GITHUB_TOKEN;

  const allChunks = [];
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

    console.log(
      `[GitHub API] Fetching chunks ${blockIndex + 1} to ${upperLimit} of ${allChunks.length}...`,
    );
    onStatus?.(
      `Downloading repo logic (${upperLimit}/${allChunks.length} chunks)`,
    );

    await Promise.all(
      batchedChunks.map(async (chunk, chunkOffset) => {
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

async function uploadAndGetResult(
  context: BrowserContext,
  files: string[],
  query: string,
  taskId: string,
  repoName: string,
) {
  try {
    const pages = context.pages();
    let page: Page | undefined = pages.find((p) =>
      p.url().includes("notebooklm.google.com"),
    );

    if (!page) {
      page = await context.newPage();
      await page.goto(NOTEBOOKLM_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    }

    if (!page) throw new Error("Could not create or find a NotebookLM page.");

    const onStatus = (msg: string) => {
      const job = activeJobs.get(taskId);
      if (job) activeJobs.set(taskId, { ...job, statusText: msg });
    };

    const result = await automateNotebookLM(
      page,
      files,
      query,
      repoName,
      onStatus,
    );
    activeJobs.set(taskId, { status: "done", result });
  } catch (err: any) {
    console.error(`[NotebookLM] Error in automateNotebookLM: ${err.message}`);
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
    activeJobs.set(taskId, { status: "pending" });

    const outDir = path.join(CONTEXT_DIR_PATH, owner, repo);

    const processJob = async () => {
      try {
        const setStatus = (msg: string) => {
          const job = activeJobs.get(taskId);
          if (job) activeJobs.set(taskId, { ...job, statusText: msg });
        };

        if (!fs.existsSync(outDir)) {
          fs.mkdirSync(outDir, { recursive: true });
          setStatus("Generating build manifest...");

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
            setStatus,
          );

          setStatus("Running static code analysis...");
          const metadata = Array.from(contents.entries()).map(([p, c]) => ({
            path: p,
            content: c,
            analysis: analyzeFile(p, c),
          }));

          setStatus("Chunking and structuring contexts...");
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

        setStatus("Bootstrapping Playwright engine...");
        const files = fs
          .readdirSync(outDir)
          .filter((f) => f.endsWith(".txt"))
          .map((f) => path.join(outDir, f))
          .sort();

        const context = await getOrCreateContext();
        await uploadAndGetResult(context, files, query, taskId, repo);
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
