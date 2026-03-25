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

// Global session management
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
  try {
    const browser = await chromium.connectOverCDP("http://127.0.0.1:9222", {
      timeout: 2000,
    });
    sharedContext = browser.contexts()[0];
  } catch {
    const browser = await chromium.launch({ headless: false });
    sharedContext = await browser.newContext();
  }
  (global as any)[GLOBAL_CONTEXT_KEY] = sharedContext;
  return sharedContext;
}

// RESTORE: GitHub content fetcher (Essential for buildMasterContext)
async function fetchFileContents(
  owner: string,
  repo: string,
  files: any[],
  ref: string,
) {
  const result = new Map<string, string>();
  const CHUNK_SIZE = 50; // Keep GraphQL complexity well within limits

  for (let i = 0; i < files.length; i += CHUNK_SIZE) {
    const chunk = files.slice(i, i + CHUNK_SIZE);

    const fields = chunk
      .map(
        (f, idx) =>
          `f${idx}: object(expression: "${ref}:${f.path}") { ... on Blob { text } }`,
      )
      .join("\n");

    const query = `{ repository(owner: "${owner}", name: "${repo}") { ${fields} } }`;

    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      console.warn(`[GitHub API] Batch failed: ${res.statusText}`);
      continue;
    }

    const { data } = await res.json();
    if (data?.repository) {
      chunk.forEach((f, idx) => {
        if (data.repository[`f${idx}`]?.text) {
          result.set(f.path, data.repository[`f${idx}`].text);
        }
      });
    }
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

    if (page) {
      await page.bringToFront();
    } else {
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
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
      // Aggressively filter out non-essential files so we capture real implementation logic
      const coreFiles = tree.filter((f: any) => {
        const p = f.path;
        // Skip tests, fixtures, docs, examples
        if (
          p.includes(".test.") ||
          p.includes(".spec.") ||
          p.includes("__tests__") ||
          p.includes("test/") ||
          p.includes("tests/") ||
          p.includes("docs/") ||
          p.includes("examples/") ||
          p.includes("fixtures/") ||
          p.includes("e2e/")
        )
          return false;

        // Skip configs, dotfiles, lockfiles
        if (p.startsWith(".") && !p.startsWith(".cargo")) return false; // Allow .cargo if needed, but skip .github, etc.
        if (p.includes(".github")) return false;
        if (
          p.endsWith(".json") ||
          p.endsWith(".md") ||
          p.endsWith(".lock") ||
          p.endsWith(".yml") ||
          p.endsWith(".yaml") ||
          p.endsWith(".toml") ||
          p.endsWith(".png") ||
          p.endsWith(".snap") ||
          p.endsWith(".txt")
        )
          return false;

        // Only include actual source extensions we care about for Deep Dive logic
        return (
          p.endsWith(".ts") ||
          p.endsWith(".tsx") ||
          p.endsWith(".js") ||
          p.endsWith(".jsx") ||
          p.endsWith(".rs") ||
          p.endsWith(".go")
        );
      });

      // No artificial string limits—we fetch EVERY remaining core file in batched chunks.
      const contents = await fetchFileContents(
        owner,
        repo,
        coreFiles,
        defaultBranch || "main",
      );
      const metadata = Array.from(contents.entries()).map(([p, c]) => ({
        path: p,
        content: c,
        analysis: analyzeFile(p, c),
      }));
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

    const files = fs
      .readdirSync(outDir)
      .filter((f) => f.endsWith(".txt"))
      .map((f) => path.join(outDir, f))
      .sort();
    const context = await getOrCreateContext();

    uploadAndGetResult(context, files, query, taskId, repo).catch(
      console.error,
    );

    return NextResponse.json({ success: true, taskId });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
