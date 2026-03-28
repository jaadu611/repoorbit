import { Page } from "playwright";
import path from "path";
import fs from "fs";
import { GeminiRouterResponse } from "./notebooklmAutomator";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GeminiAutomatorOptions {
  /** Absolute path to the router_index.json produced by buildMasterContext() */
  routerIndexPath: string;
  /** The user's natural-language question to route */
  userQuery: string;
  /** Optional: override the default system prompt */
  systemPrompt?: string;
  /** Optional: status callback for progress reporting */
  onStatus?: (msg: string) => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GEMINI_URL = "https://gemini.google.com/";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripJsonFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function extractJsonFromText(text: string): string {
  const startIndices: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") startIndices.push(i);
  }

  const blocks: string[] = [];
  for (const start of startIndices) {
    let balance = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === "{") balance++;
        else if (char === "}") balance--;

        if (balance === 0) {
          blocks.push(text.substring(start, i + 1));
          break;
        }
      }
    }
  }

  // Look for our specific routing object signature
  // We prefer the longest block that matches and has the required keys
  const candidates = blocks
    .filter((b) => b.includes("notebooks") && b.includes("queryPerNotebook"))
    .sort((a, b) => b.length - a.length);

  if (candidates.length > 0) return candidates[0];

  // Fallback to the largest block that starts with { and ends with } (greedy)
  const greedyMatch = text.match(/\{[\s\S]*\}/);
  if (greedyMatch) return greedyMatch[0];
  
  return text;
}

function parseRouterResponse(raw: string): GeminiRouterResponse {
  const jsonPart = extractJsonFromText(raw);
  const cleaned = stripJsonFences(jsonPart);
  
  try {
    const parsed = JSON.parse(cleaned);

    // Validate shape
    if (!Array.isArray(parsed.notebooks)) {
      throw new Error("Missing or invalid 'notebooks' array in Gemini response");
    }
    if (typeof parsed.crossBoundary !== "boolean") {
      throw new Error("Missing or invalid 'crossBoundary' boolean");
    }
    if (
      typeof parsed.queryPerNotebook !== "object" ||
      parsed.queryPerNotebook === null
    ) {
      throw new Error("Missing or invalid 'queryPerNotebook' object");
    }

    // Ensure every notebook in the list has a query
    for (const nb of parsed.notebooks) {
      if (!parsed.queryPerNotebook[String(nb)]) {
        throw new Error(
          `queryPerNotebook is missing an entry for notebook ${nb}`,
        );
      }
    }

    return parsed as GeminiRouterResponse;
  } catch (err: any) {
    if (err instanceof SyntaxError) {
      throw new Error(`JSON Syntax Error: ${err.message}. Cleaned string: ${cleaned.slice(0, 200)}...`);
    }
    throw err;
  }
}

// ─── Gemini file upload helpers ───────────────────────────────────────────────

async function waitForGeminiReady(
  page: Page,
  onStatus?: (msg: string) => void,
): Promise<void> {
  onStatus?.("Waiting for Gemini to load...");
  await page.waitForLoadState("domcontentloaded", { timeout: 45000 });

  // Wait for the chat input to be present
  const inputSelectors = [
    'div[contenteditable="true"]',
    'textarea[placeholder*="message"]',
    'textarea[aria-label*="message"]',
    ".ql-editor",
    '[data-testid="chat-input"]',
  ];

  for (const sel of inputSelectors) {
    const visible = await page
      .locator(sel)
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    if (visible) return;
  }

  // Fallback: just wait a bit
  await page.waitForTimeout(4000);
}

async function uploadFileToGemini(
  page: Page,
  filePath: string,
  onStatus?: (msg: string) => void,
): Promise<void> {
  onStatus?.(`Uploading ${path.basename(filePath)} to Gemini...`);

  // Attempt to find the file upload button
  const uploadSelectors = [
    'button[aria-label*="Upload"]',
    'button[aria-label*="Attach"]',
    'button[aria-label*="file"]',
    '[data-testid*="upload"]',
    '[data-testid*="attach"]',
    'button:has-text("Upload")',
    // Gemini sometimes uses a + icon or paperclip
    'button[aria-label*="Add"]',
    'button[jsname*="upload"]',
    '[mattooltip*="Upload"]',
    '[mattooltip*="Attach"]',
  ];

  let fileChooserOpened = false;
  let retries = 8;

  while (!fileChooserOpened && retries > 0) {
    for (const sel of uploadSelectors) {
      const btn = page.locator(sel).first();
      const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
      if (!visible) continue;

      try {
        const [fileChooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 10000 }),
          btn.click({ force: true }),
        ]);
        await fileChooser.setFiles(filePath);
        fileChooserOpened = true;
        break;
      } catch {
        // try next selector
      }
    }

    if (!fileChooserOpened) {
      retries--;
      onStatus?.(
        `Upload button not found, retrying... (${retries} attempts left)`,
      );
      await page.waitForTimeout(2000);
    }
  }

  if (!fileChooserOpened) {
    throw new Error(
      "Could not find a file upload button on Gemini. The UI may have changed.",
    );
  }

  // Wait for the file to finish uploading (thumbnail or filename appears)
  onStatus?.("Waiting for file to process...");
  await page
    .waitForSelector(
      [
        '[data-testid*="file-chip"]',
        ".file-thumbnail",
        `[title="${path.basename(filePath)}"]`,
        `[aria-label*="${path.basename(filePath)}"]`,
        ".attachment-chip",
        'div:has-text("router_index")',
      ].join(", "),
      { timeout: 30000 },
    )
    .catch(() => {
      // Non-fatal: file may have uploaded but chip selector missed
      onStatus?.("File chip not detected — proceeding anyway.");
    });

  await page.waitForTimeout(1500);
}

async function sendMessageToGemini(
  page: Page,
  message: string,
  onStatus?: (msg: string) => void,
): Promise<void> {
  onStatus?.("Sending query to Gemini...");

  const inputSelectors = [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea[placeholder*="message"]',
    'textarea[aria-label*="message"]',
    ".ql-editor",
    '[data-testid="chat-input"]',
  ];

  let inputElement = null;
  for (const sel of inputSelectors) {
    const el = page.locator(sel).first();
    const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      inputElement = el;
      break;
    }
  }

  if (!inputElement) {
    throw new Error("Could not find Gemini chat input to type into.");
  }

  // Force focus and fill
  await inputElement.click({ force: true });
  await page.waitForTimeout(500);
  await inputElement.fill(message);
  await page.waitForTimeout(1000);

  // Send: try multiple selectors for the send button
  const sendSelectors = [
    'button[aria-label*="Send"]',
    'button[aria-label*="Submit"]',
    'button[data-testid*="send"]',
    'button[jsname*="send"]',
    'button:has(svg[aria-label*="Send"])',
    'button:has(svg[aria-label*="send"])',
    'button:has(svg)', 
    'button:has(i:has-text("send"))',
    '.send-button',
    '[role="button"][aria-label*="Send"]',
  ];

  let sent = false;
  for (const sel of sendSelectors) {
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible({ timeout: 1000 }).catch(() => false);
    const enabled = visible && await btn.isEnabled().catch(() => false);
    
    if (enabled) {
      onStatus?.(`Clicking send button (${sel})...`);
      await btn.click({ force: true }).catch(() => {});
      sent = true;
      break;
    }
  }

  // Keyboard fallback
  if (!sent) {
    onStatus?.("Send button not found or inactive. Using keyboard (Enter)...");
    await inputElement.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);
    await page.keyboard.press("Control+Enter");
  }

  // Verification: Wait for some sign that generation started
  onStatus?.("Verifying message delivery...");
  const generationStarted = await page
    .locator('.loading-indicator, [aria-label*="Stop"], [aria-label*="Generating"], .generating-text, .stop-generating-button')
    .first()
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  if (!generationStarted) {
    onStatus?.("Warning: Could not confirm generation. One last focus + Enter...");
    await inputElement.click({ force: true }).catch(() => {});
    await page.keyboard.press("Enter");
  }
}

async function waitForGeminiResponse(
  page: Page,
  onStatus?: (msg: string) => void,
): Promise<string> {
  onStatus?.("Waiting for Gemini response...");

  const startTime = Date.now();
  const TIMEOUT_MS = 120_000; // 2 minutes

  // Selectors that typically hold Gemini's response text
  const responseSelectors = [
    ".response-content",
    ".model-response-text",
    '[data-testid="response-container"]',
    ".markdown",
    'div[class*="response"]',
    'div[class*="message"]:last-child',
    // Gemini uses mat-* components
    "mat-expansion-panel",
    '.conversation-container div[role="presentation"]:last-child',
  ];

  let lastText = "";
  let stableCount = 0;
  const STABLE_NEEDED = 3;

  while (Date.now() - startTime < TIMEOUT_MS) {
    await page.waitForTimeout(2000);

    // Grab all visible text from response containers
    const candidateTexts = await Promise.all(
      responseSelectors.map(async (sel) => {
        try {
          const els = page.locator(sel);
          const count = await els.count();
          if (count === 0) return "";
          // Get the last element's text (most recent response)
          return (await els.last().innerText()).trim();
        } catch {
          return "";
        }
      }),
    );

    // Pick the longest non-empty candidate that looks like JSON
    const jsonCandidates = candidateTexts
      .filter((t) => t.length > 10 && t.includes("{"))
      .sort((a, b) => b.length - a.length);

    const best = jsonCandidates[0] ?? "";

    if (best && best === lastText) {
      stableCount++;
      if (stableCount >= STABLE_NEEDED) {
        onStatus?.("Response stabilised.");
        return best;
      }
    } else {
      stableCount = 0;
      lastText = best;
      if (best) onStatus?.("Gemini is generating...");
    }
  }

  // Last-ditch: scrape the full page body and try to extract JSON
  onStatus?.("Timeout — scraping full page for JSON...");
  const fullBody = await page.evaluate(() => document.body.innerText);
  return fullBody;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runGeminiRouter(
  page: Page,
  options: GeminiAutomatorOptions,
): Promise<GeminiRouterResponse> {
  const {
    routerIndexPath,
    userQuery,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    onStatus,
  } = options;

  // ── Validate inputs ─────────────────────────────────────────────────────────
  if (!fs.existsSync(routerIndexPath)) {
    throw new Error(`router_index.json not found at: ${routerIndexPath}`);
  }

  const routerIndexRaw = fs.readFileSync(routerIndexPath, "utf-8");

  // Quick sanity-check that it's valid JSON
  try {
    JSON.parse(routerIndexRaw);
  } catch {
    throw new Error(
      `router_index.json at ${routerIndexPath} is not valid JSON`,
    );
  }

  onStatus?.("Navigating to Gemini...");
  await page.goto(GEMINI_URL, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });

  await waitForGeminiReady(page, onStatus);

  // ── Upload router_index.json ────────────────────────────────────────────────
  await uploadFileToGemini(page, routerIndexPath, onStatus);

  // ── Compose the full prompt ─────────────────────────────────────────────────
  // We send system prompt + user query in one message since Gemini's web UI
  // doesn't have a separate system prompt field.
  const fullPrompt = [
    systemPrompt,
    "",
    "---",
    "",
    `USER QUESTION: ${userQuery}`,
    "",
    "Respond with ONLY the JSON routing object. No prose, no markdown fences.",
  ].join("\n");

  await sendMessageToGemini(page, fullPrompt, onStatus);

  // ── Wait for and parse the response ────────────────────────────────────────
  const rawResponse = await waitForGeminiResponse(page, onStatus);

  onStatus?.("Parsing Gemini routing response...");

  let parsed: GeminiRouterResponse;
  try {
    parsed = parseRouterResponse(rawResponse);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to parse Gemini router response: ${errMsg}\n\nRaw response (first 500 chars):\n${rawResponse.slice(0, 500)}`,
    );
  }

  onStatus?.(
    `Routing complete: notebooks=[${parsed.notebooks.join(",")}] crossBoundary=${parsed.crossBoundary}`,
  );

  return parsed;
}

// ─── Convenience: run router and immediately feed into notebooklm ─────────────
// Import automateNotebookLM from notebooklm.ts and wire them together.

export { DEFAULT_SYSTEM_PROMPT };
