import { Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { NotebookPlan } from "@/lib/types";

export async function askDeepseek(
  page: Page,
  query: string,
  manifestContent: string,
  contextDir: string,
  onStatus?: (msg: string, partial?: string, progress?: number) => void,
  outDir: string = "",
  isFirstTurn: boolean = true,
): Promise<string> {
  const url = page.url();
  if (!url.includes("chat.deepseek.com")) {
    onStatus?.("Navigating to Deepseek...");
    await page.goto("https://chat.deepseek.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(3000);
  }

  // Create a unique session directory for this specific run
  const sessionDir = path.join(os.tmpdir(), `deepseek_upload_${Date.now()}`);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const allTmpPaths: string[] = [];

  // ── 1. Stage Context Files (from deepseek_context folder) ────────────────
  if (fs.existsSync(contextDir)) {
    const contextFiles = fs
      .readdirSync(contextDir)
      .filter((f) => f.endsWith(".js") || f.endsWith(".txt"))
      .sort((a, b) => {
        if (a === "context.js") return -1;
        if (b === "context.js") return 1;
        return a.localeCompare(b);
      });

    for (const fileName of contextFiles) {
      const content = fs.readFileSync(path.join(contextDir, fileName), "utf-8");
      const tmpPath = path.join(sessionDir, fileName);
      fs.writeFileSync(tmpPath, content, "utf-8");
      allTmpPaths.push(tmpPath);
      console.log(`[Deepseek] Staged Context: ${fileName}`);
    }
  }

  // ── 2. Stage Structural Metadata ─────────────────────────────────────────
  if (isFirstTurn) {
    const metadataBase =
      outDir && fs.existsSync(outDir) ? outDir : process.cwd();

    // graph.json is excluded — 68k+ lines for Postgres, irrelevant for function-level fixes.
    // Dependency info is already embedded in context.js via // --- Source: ... --- headers.
    const rootMetadata = ["00_Root_Manifest.txt"];

    for (const fileName of rootMetadata) {
      const filePath = path.join(metadataBase, fileName);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        const tmpPath = path.join(sessionDir, fileName);
        fs.writeFileSync(tmpPath, content, "utf-8");
        allTmpPaths.push(tmpPath);
        console.log(
          `[Deepseek] Staged Metadata: ${fileName} (from ${metadataBase})`,
        );
      } else {
        console.error(
          `[Deepseek] CRITICAL: ${fileName} NOT FOUND at ${filePath}`,
        );
      }
    }
  }

  // ── 5. Single Atomic Upload ──────────────────────────────────────────────
  onStatus?.(`Uploading ${allTmpPaths.length} file(s) to Deepseek...`);
  await uploadFilesToDeepseek(page, allTmpPaths);

  // ── 6. Send Query ────────────────────────────────────────────────────────
  onStatus?.("Sending query to Deepseek...");
  await typeAndSubmit(page, query);

  onStatus?.("Waiting for Deepseek to respond...");
  const rawText = await waitForDeepseekCompletion(page, onStatus);

  return rawText;
}

export function cleanupDeepseekTempFiles(paths: string[]): void {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log(`[Deepseek] Cleaned up temp file: ${p}`);
      }
    } catch (e) {
      console.warn(`[Deepseek] Could not delete temp file ${p}:`, e);
    }
  }
}

// ── Single multi-file upload ──────────────────────────────────────────────────

async function uploadFilesToDeepseek(
  page: Page,
  filePaths: string[],
): Promise<void> {
  if (filePaths.length === 0) return;

  const attemptUpload = async () => {
    // Stage 1: Attempt the sequential upload
    for (const file of filePaths) {
      console.log(`[Deepseek] Uploading file 1-by-1: ${path.basename(file)}...`);
      
      const attachSelectors = [
        'button[aria-label*="attach" i]',
        'button[aria-label*="upload" i]',
        'button[aria-label*="file" i]',
        'label[for*="file" i]',
        'button[data-testid*="attach" i]',
        'button svg[data-icon="paperclip"]',
      ];

      let fileInput = await page.$('input[type="file"]');
      if (!fileInput) {
        for (const sel of attachSelectors) {
          try {
            const exists = await page.waitForSelector(sel, { timeout: 1000 }).catch(() => null);
            if (exists) {
              await page.click(sel, { force: true });
              await page.waitForTimeout(500);
              fileInput = await page.$('input[type="file"]');
              if (fileInput) break;
            }
          } catch {}
        }
      }

      if (!fileInput) {
        const handle = await page.evaluateHandle(() => {
          const inputs = Array.from(
            document.querySelectorAll('input[type="file"]'),
          );
          const el = inputs[0] as HTMLInputElement | undefined;
          if (el) {
            el.style.display = "block";
            el.style.opacity = "1";
            el.style.position = "fixed";
            el.style.top = "0";
            el.style.left = "0";
            el.style.zIndex = "99999";
          }
          return el ?? null;
        });
        fileInput = handle.asElement();
      }

      if (!fileInput) throw new Error("Could not find a file input on DeepSeek.");
      await fileInput.setInputFiles([file]);
      await page.waitForTimeout(1000);

      // Wait for the parsing chip to clear
      try {
        await page.waitForFunction(() => {
          const fileChips = Array.from(
            document.querySelectorAll('[class*="file"], [class*="upload"], [class*="attach"]')
          );
          for (const chip of fileChips) {
            const text = (chip as HTMLElement).innerText?.toLowerCase() || "";
            if (
              text.includes("pending") ||
              text.includes("parsing") ||
              text.includes("uploading") ||
              text.includes("loading")
            ) {
              return false;
            }
          }
          return !document.querySelector('[class*="uploading"], [class*="spinner"], .ds-loading');
        }, { timeout: 45_000 });
      } catch (err) {
        console.warn(`[Deepseek] Parsing stalled for ${path.basename(file)}. Reloading page...`);
        throw new Error("RELOAD_SIGNAL");
      }
      
      await page.waitForTimeout(1000);
    }
  };

  try {
    await attemptUpload();
  } catch (err: any) {
    if (err.message === "RELOAD_SIGNAL") {
      console.log("[Deepseek] Triggering page reload and restarting upload...");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(5000);
      return uploadFilesToDeepseek(page, filePaths); // Retry from start
    }
    console.error(`[Deepseek] CRITICAL: Upload sequence failed: ${err.message}`);
  }
}

// ─── Input & submit ───────────────────────────────────────────────────────────

async function typeAndSubmit(page: Page, message: string): Promise<void> {
  const inputSelector = '#chat-input, textarea, [contenteditable="true"]';
  await page.waitForSelector(inputSelector, { timeout: 30000 });

  const inputLocator = page.locator(inputSelector).first();

  // Ensure the input area is clear and we are focused
  await inputLocator.click();

  try {
    // Locator.fill supports contenteditable in Playwright
    await inputLocator.fill(message);
  } catch {
    // Fallback if fill fails for some reason
    await page.evaluate((text) => {
      const el = document.querySelector(
        '#chat-input, textarea, [contenteditable="true"]',
      ) as HTMLElement;
      if (el) {
        el.innerText = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, message);
  }

  // Deepseek can block submission if uploading isn't technically complete
  await page.waitForTimeout(1000);

  // Try to find the send button and click it, fallback to Enter
  const sendSelectors = [
    'div.ds-icon-button[role="button"]:not([aria-disabled="true"])',
    'button[aria-label*="send" i]',
    'div[role="button"][style*="cursor: pointer"] svg',
  ];

  let clicked = false;
  for (const sel of sendSelectors) {
    try {
      const btn = page.locator(sel).last();
      if (await btn.isVisible()) {
        await btn.click({ timeout: 2000, force: true });
        clicked = true;
        break;
      }
    } catch {}
  }

  if (!clicked) {
    await page.keyboard.press("Enter");
  }
}

// ─── Response polling ─────────────────────────────────────────────────────────

async function waitForDeepseekCompletion(
  page: Page,
  onStatus?: (msg: string, partial?: string, progress?: number) => void,
  timeoutMs = 300_000,
): Promise<string> {
  const startTime = Date.now();
  let lastSeenText = "";
  let stableCount = 0;
  const STABLE_POLLS_NEEDED = 5;

  await page.waitForTimeout(2000);

  while (Date.now() - startTime < timeoutMs) {
    const candidate = await page.evaluate<{
      text: string;
      isGenerating: boolean;
    } | null>(() => {
      const isGenerating =
        Array.from(
          document.querySelectorAll('button, div[role="button"]'),
        ).some((el) => {
          const text = (el as HTMLElement).textContent?.trim() ?? "";
          const label = el.getAttribute("aria-label")?.toLowerCase() ?? "";
          return (
            text === "Stop" ||
            label.includes("stop") ||
            label.includes("cancel")
          );
        }) ||
        document.querySelector(
          '.ds-loading, [class*="loading"], [class*="generating"], .ds-icon-stop'
        ) !== null;

      // New: Check for indicators that it IS finished
      const isDone = document.querySelector(
        'button[aria-label*="Regenerate" i], .ds-icon-regenerate, [class*="regenerate"], .ds-icon-copy'
      ) !== null;

      const selectors = [
        '[data-message-author-role="assistant"]',
        ".ds-markdown",
        '.markdown-body:not([class*="user"])',
        '.prose:not([class*="user"])',
        '[class*="assistant"]',
      ];

      let lastBubble: HTMLElement | null = null;
      for (const sel of selectors) {
        const nodes = Array.from(document.querySelectorAll<HTMLElement>(sel));
        if (nodes.length > 0) {
          lastBubble = nodes[nodes.length - 1];
          break;
        }
      }

      if (!lastBubble) return null;
      const text = lastBubble.innerText?.trim() ?? "";
      if (!text) return null;
      
      return { text, isGenerating: isGenerating && !isDone };
    });

    if (candidate && candidate.text.length > 0) {
      const preview = candidate.text.substring(0, 120).replace(/\n/g, " ");
      onStatus?.("Deepseek generating...", preview + "...");

      if (candidate.text === lastSeenText && !candidate.isGenerating) {
        stableCount++;
        if (stableCount >= STABLE_POLLS_NEEDED) {
          onStatus?.("Deepseek response complete.");
          return candidate.text;
        }
      } else {
        stableCount = 0;
        lastSeenText = candidate.text;
      }
    }

    await page.waitForTimeout(1000);
  }

  if (lastSeenText.length > 0) {
    onStatus?.("Deepseek timed out — using partial response.");
    return lastSeenText;
  }

  throw new Error(
    "Deepseek analysis timeout after 5 minutes with no response.",
  );
}

// ─── Response parser ──────────────────────────────────────────────────────────

export function parseNotebookPlan(raw: string): NotebookPlan {
  const attempts: Array<() => NotebookPlan | null> = [
    () => {
      try {
        return validatePlan(JSON.parse(raw.trim()));
      } catch {
        return null;
      }
    },
    () => {
      const m = raw.match(/```(?:[a-z]*)?\s*([\s\S]*?)```/i);
      if (!m) return null;
      try {
        return validatePlan(JSON.parse(stripAssignment(m[1].trim())));
      } catch {
        return null;
      }
    },
    () => {
      const m = raw.match(
        /(?:const|let|var)?\s*\w+\s*=\s*(\{[\s\S]*"notebooks"[\s\S]*\})/,
      );
      if (!m) return null;
      try {
        return validatePlan(JSON.parse(m[1]));
      } catch {
        return null;
      }
    },
    () => {
      const start = raw.indexOf('{"notebooks"');
      const altStart = raw.indexOf('{ "notebooks"');
      const idx = [start, altStart]
        .filter((i) => i >= 0)
        .sort((a, b) => a - b)[0];
      if (idx === undefined || idx < 0) return null;
      const slice = extractBalancedObject(raw, idx);
      if (!slice) return null;
      try {
        return validatePlan(JSON.parse(slice));
      } catch {
        return null;
      }
    },
    () => {
      const idx = raw.indexOf("{");
      if (idx < 0) return null;
      const slice = extractBalancedObject(raw, idx);
      if (!slice) return null;
      try {
        return validatePlan(JSON.parse(slice));
      } catch {
        return null;
      }
    },
  ];

  for (const attempt of attempts) {
    const result = attempt();
    if (result) return result;
  }

  throw new Error(
    `Could not parse NotebookPlan from Deepseek response.\n` +
      `Raw response (first 500 chars):\n${raw.slice(0, 500)}`,
  );
}

function stripAssignment(s: string): string {
  return s
    .replace(/^(?:(?:const|let|var)\s+)?\w+\s*=\s*/, "")
    .trimEnd()
    .replace(/;$/, "");
}

function extractBalancedObject(text: string, startIdx: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  let quoteChar = "";

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (inString) {
      if (ch === quoteChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quoteChar = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

function validatePlan(obj: unknown): NotebookPlan {
  if (
    !obj ||
    typeof obj !== "object" ||
    (!Array.isArray((obj as any).notebooks) &&
      typeof (obj as any).direct_answer !== "string")
  ) {
    throw new Error(
      "Invalid NotebookPlan shape: expected { notebooks: [...] } or { direct_answer: '...' }",
    );
  }

  const plan = obj as NotebookPlan;
  if (plan.direct_answer) return plan;
  if (!plan.notebooks || plan.notebooks.length === 0) {
    throw new Error("NotebookPlan has zero notebooks.");
  }

  for (const nb of plan.notebooks) {
    if (typeof nb.name !== "string" || typeof nb.sub_question !== "string") {
      throw new Error(
        `Invalid notebook entry — must have string "name" and "sub_question". Got: ${JSON.stringify(nb)}`,
      );
    }
    if (!nb.name.trim() || !nb.sub_question.trim()) {
      throw new Error(
        `Notebook entry has empty name or sub_question: ${JSON.stringify(nb)}`,
      );
    }
  }

  return plan;
}
