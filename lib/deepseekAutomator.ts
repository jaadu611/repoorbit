import { Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { DEEPSEEK_CODING_PROMPT } from "./prompts";

export interface NotebookEntry {
  name: string;
  sub_question: string;
}

export interface NotebookPlan {
  notebooks: NotebookEntry[];
}

export async function askDeepseek(
  page: Page,
  query: string,
  manifestContent: string,
  onStatus?: (msg: string, partial?: string, progress?: number) => void,
): Promise<NotebookPlan> {
  const url = page.url();
  if (!url.includes("chat.deepseek.com")) {
    onStatus?.("Navigating to Deepseek...");
    await page.goto("https://chat.deepseek.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(3000);
  }

  onStatus?.("Preparing manifest file for upload...");
  const tmpPath = path.join(os.tmpdir(), `manifest_${Date.now()}.txt`);
  fs.writeFileSync(tmpPath, manifestContent, "utf-8");

  try {
    onStatus?.("Uploading manifest to Deepseek...");
    await uploadFileToDeepseek(page, tmpPath);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
  }

  onStatus?.("Sending query to Deepseek...");
  const message = buildPrompt(query);

  await typeAndSubmit(page, message);

  onStatus?.("Waiting for Deepseek to respond...");

  const rawText = await waitForDeepseekCompletion(page, onStatus);

  onStatus?.("Parsing Deepseek response...");
  return parseNotebookPlan(rawText);
}

async function uploadFileToDeepseek(
  page: Page,
  filePath: string,
): Promise<void> {
  const attachSelectors = [
    'button[aria-label*="attach" i]',
    'button[aria-label*="upload" i]',
    'button[aria-label*="file" i]',
    'label[for*="file" i]',
    'button[data-testid*="attach" i]',
    'button svg[data-icon="paperclip"]',
    'button:has(svg[viewBox]) ~ input[type="file"]',
  ];

  let fileInput = await page.$('input[type="file"]');

  if (!fileInput) {
    for (const sel of attachSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          await page.waitForTimeout(500);
          fileInput = await page.$('input[type="file"]');
          if (fileInput) break;
        }
      } catch {}
    }
  }

  if (!fileInput) {
    fileInput = (await page.evaluateHandle(() => {
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
    })) as any;
  }

  if (!fileInput) {
    throw new Error(
      "Could not find a file input on DeepSeek to upload the manifest. " +
        "Skipping file upload — manifest will not be attached.",
    );
  }

  await fileInput.setInputFiles(filePath);

  // Wait for upload indicator to appear and then disappear (upload complete)
  try {
    // Wait up to 15s for an upload progress/success indicator
    await page.waitForSelector(
      '[class*="upload"], [class*="attach"], [class*="file-preview"], [aria-label*="uploaded" i]',
      { timeout: 15000 },
    );
    // Then wait for it to settle (no spinner)
    await page.waitForTimeout(1500);
  } catch {
    // No upload indicator found — just wait a moment and continue
    await page.waitForTimeout(2000);
  }
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(query: string): string {
  return `${DEEPSEEK_CODING_PROMPT}${query}`;
}

// ─── Input & submit ───────────────────────────────────────────────────────────

async function typeAndSubmit(page: Page, message: string): Promise<void> {
  const inputSelector = '#chat-input, textarea, [contenteditable="true"]';
  await page.waitForSelector(inputSelector, { timeout: 30000 });

  const tagName = await page.$eval(inputSelector, (el) =>
    el.tagName.toLowerCase(),
  );

  if (tagName === "textarea") {
    await page.fill(inputSelector, message);
  } else {
    await page.click(inputSelector);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await page.waitForTimeout(100);
    // Use clipboard paste for speed and to avoid contenteditable quirks
    await page.evaluate((text) => {
      const el = document.querySelector(
        '#chat-input, textarea, [contenteditable="true"]',
      ) as HTMLElement;
      if (el) {
        el.focus();
        // For contenteditable
        if (el.getAttribute("contenteditable") !== null) {
          el.innerText = text;
          // Dispatch input event so React/Vue pick up the change
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    }, message);
  }

  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
}

// ─── Response polling ─────────────────────────────────────────────────────────

/**
 * Polls until DeepSeek's last assistant bubble has been unchanged for
 * STABLE_POLLS_NEEDED consecutive 1-second ticks AND the Stop button is gone.
 */
async function waitForDeepseekCompletion(
  page: Page,
  onStatus?: (msg: string, partial?: string, progress?: number) => void,
  timeoutMs = 300_000,
): Promise<string> {
  const startTime = Date.now();
  let lastSeenText = "";
  let stableCount = 0;
  const STABLE_POLLS_NEEDED = 5;

  // Give DeepSeek a moment to start generating before we poll
  await page.waitForTimeout(2000);

  while (Date.now() - startTime < timeoutMs) {
    const candidate = await page.evaluate<{
      text: string;
      isGenerating: boolean;
    } | null>(() => {
      // ── Is DeepSeek still generating? ────────────────────────────────────
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
          '.ds-loading, [class*="loading"], [class*="generating"], [class*="spinner"]',
        ) !== null;

      // ── Find the last assistant message ───────────────────────────────────
      // Priority order: most specific → most generic
      const selectors = [
        // DeepSeek v2+ role attribute
        '[data-message-author-role="assistant"]',
        // DeepSeek classic markdown wrapper
        ".ds-markdown",
        // Common markdown renderers, excluding user bubbles
        '.markdown-body:not([class*="user"])',
        '.prose:not([class*="user"])',
        // Any element with "assistant" in its class/data
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

      // Grab innerText (rendered text, not raw HTML)
      const text = lastBubble.innerText?.trim() ?? "";
      if (!text) return null;

      return { text, isGenerating };
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

  // If we timed out but have something, return it rather than throwing
  if (lastSeenText.length > 0) {
    onStatus?.("Deepseek timed out — using partial response.");
    return lastSeenText;
  }

  throw new Error(
    "Deepseek analysis timeout after 5 minutes with no response.",
  );
}

// ─── Response parser ──────────────────────────────────────────────────────────

/**
 * Extracts a NotebookPlan from DeepSeek's raw response. Handles:
 *   - Clean JSON
 *   - ```json ... ``` or ```typescript ... ``` fenced blocks
 *   - JS/TS variable assignments:  const X = { ... }  or  HARDCODED_PLAN = { ... }
 *   - JSON object embedded anywhere in prose
 */
export function parseNotebookPlan(raw: string): NotebookPlan {
  const attempts: Array<() => NotebookPlan | null> = [
    // 1. Clean JSON string
    () => {
      try {
        return validatePlan(JSON.parse(raw.trim()));
      } catch {
        return null;
      }
    },

    // 2. ```json ... ``` or ``` ... ``` fence (any language tag)
    () => {
      const m = raw.match(/```(?:[a-z]*)?\s*([\s\S]*?)```/i);
      if (!m) return null;
      // Strip JS/TS variable assignment inside the fence
      const inner = stripAssignment(m[1].trim());
      try {
        return validatePlan(JSON.parse(inner));
      } catch {
        return null;
      }
    },

    // 3. JS/TS variable assignment outside a fence:
    //    const PLAN = { ... }  /  let x = { ... }  /  HARDCODED_PLAN = { ... }
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

    // 4. Bare JSON object containing "notebooks" anywhere in the text
    () => {
      // Find the first '{' that introduces the notebooks object
      const start = raw.indexOf('{"notebooks"');
      const altStart = raw.indexOf('{ "notebooks"');
      const idx = [start, altStart]
        .filter((i) => i >= 0)
        .sort((a, b) => a - b)[0];
      if (idx === undefined || idx < 0) return null;
      // Walk forward to find the matching closing brace
      const slice = extractBalancedObject(raw, idx);
      if (!slice) return null;
      try {
        return validatePlan(JSON.parse(slice));
      } catch {
        return null;
      }
    },

    // 5. Any JSON object in the text (broadest fallback)
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

/** Strips  `const FOO =` / `let foo =` / `PLAN =`  prefix from a string. */
function stripAssignment(s: string): string {
  return s
    .replace(/^(?:(?:const|let|var)\s+)?\w+\s*=\s*/, "")
    .trimEnd()
    .replace(/;$/, "");
}

/**
 * Extracts the balanced `{ ... }` object starting at `startIdx` in `text`.
 * Returns null if braces don't balance within the string.
 */
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

// ─── Validator ────────────────────────────────────────────────────────────────

function validatePlan(obj: unknown): NotebookPlan {
  if (
    !obj ||
    typeof obj !== "object" ||
    !Array.isArray((obj as any).notebooks)
  ) {
    throw new Error(
      "Invalid NotebookPlan shape: expected { notebooks: [...] }",
    );
  }

  const plan = obj as NotebookPlan;

  if (plan.notebooks.length === 0) {
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
