import { NextResponse } from "next/server";
import { buildMasterContext, buildFallbackContext } from "@/lib/contextBuilder";
import { getCachedFiles } from "@/lib/serverCache";
import { chromium, BrowserContext, Page } from "playwright";
import path from "path";
import fs from "fs";

const CONTEXT_FILE_PATH = "/tmp/contextForNotebook.txt";
const GEMINI_CONTEXT_PATH = "/tmp/contextForGemini.txt";
const NOTEBOOKLM_URL = "https://notebooklm.google.com/";
const AUTH_STATE_PATH = path.resolve(process.cwd(), ".playwright-auth.json");

// ── Global session management ────────────────────────────────────────────────

// Using global to persist context across HMR in development
const GLOBAL_CONTEXT_KEY = Symbol.for("repoorbit.playwright.context");

let sharedContext: BrowserContext | null =
  (global as any)[GLOBAL_CONTEXT_KEY] || null;

/**
 * Ensures we have a valid browser context, either by connecting to a running
 * Brave instance via CDP or reusing/launching a Playwright-managed one.
 */
async function getOrCreateContext(
  executablePath: string | undefined,
): Promise<BrowserContext> {
  // 1. Try to connect to a running Brave instance (started with --remote-debugging-port=9222)
  // TIP: Start Brave with 'brave-browser --remote-debugging-port=9222' to use your primary session
  try {
    const browser = await chromium.connectOverCDP("http://localhost:9222", {
      timeout: 1000,
    });
    const contexts = browser.contexts();
    if (contexts.length > 0) {
      console.info("Connected to existing Brave session via CDP (port 9222).");
      return contexts[0];
    }
    // If no contexts but connected, create one
    return await browser.newContext();
  } catch (e) {
    // Port 9222 not open or connection failed, continue
  }

  // 2. Try to reuse a previously launched Playwright context
  if (sharedContext) {
    try {
      // Check if context is still alive by checking pages
      const pages = sharedContext.pages();
      if (pages.length > 0) {
        await pages[0].evaluate(() => 1);
      } else {
        await sharedContext.newPage();
      }
      return sharedContext;
    } catch (e) {
      console.info("Shared context is dead or disconnected, recreating…");
      sharedContext = null;
      (global as any)[GLOBAL_CONTEXT_KEY] = null;
    }
  }

  // 3. Launch a new persistent context (and cache it)
  const { context } = await createAuthenticatedContext(executablePath);
  sharedContext = context;
  (global as any)[GLOBAL_CONTEXT_KEY] = context;
  return context;
}

/**
 * Uses Gemini (via web scraping as requested) to plan which files are 
 * relevant to the user query before building the full context.
 */
async function planWithGemini(context: BrowserContext, query: string, repoContext: any, files: any[]): Promise<any> {
  const tree = files.map(f => f.path).join("\n");
  const prompt = `
Codebase context planning task. 
Repo: ${repoContext.meta?.fullName}
Description: ${repoContext.github?.description || "none"}
Topics: ${repoContext.github?.topics?.join(", ") || "none"}

User Query: "${query}"

Your task is to decide which data sections are essential.
- If it's a high-level/generic query (overview, summarize, about this repo), return "files": [] and focus ONLY on "repo_meta" and "tree" intents. 
- Only include specific source files if the query explicitly asks about logic, symbols (classes/functions), or how something is implemented.
- If the query is vague, prefer fewer files.

Respond ONLY with a JSON object in this format (no other text):
{
  "files": [],
  "intents": ["repo_meta", "tree"],
  "focus": "generic"
}

File Tree Summary:
${tree.slice(0, 15000)} ${tree.length > 15000 ? "\n[TRUNCATED]" : ""}
`;

  const page = await context.newPage();
  try {
    console.info("Consulting Gemini for expert planning…");
    // Use domcontentloaded as networkidle is too strict for Gemini
    await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });
    
    // Selectors found by subagent
    const textbox = page.locator('div[role="textbox"], .ql-editor, [aria-label*="Enter a prompt"]').first();
    const sendBtn = page.locator('button[aria-label*="Send"], .send-button').first();
    
    // Wait for the prompt box to actually be interactive
    await textbox.waitFor({ state: "visible", timeout: 20000 });
    
    // Use fill instead of type to prevent newlines from triggering 'Enter'
    await textbox.focus();
    await textbox.fill(prompt);
    
    // Dispatch input event to ensure the 'Send' button activates
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.dispatchEvent(new Event('input', { bubbles: true }));
    }, 'div[role="textbox"], .ql-editor');
    
    // Give a small moment for the send button to activate
    await page.waitForTimeout(1000);
    await sendBtn.waitFor({ state: "visible", timeout: 10000 });
    await sendBtn.click();
    
    // Wait for response text to appear and settle
    const responseEl = page.locator('.model-response-text').first();
    await responseEl.waitFor({ state: "visible", timeout: 45000 });
    
    // Wait for "generating" state to end (Gemini sometimes shows text incrementally)
    await page.waitForTimeout(5000); 
    
    const rawText = await responseEl.innerText();
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) {
      const plan = JSON.parse(match[0]);
      console.info(`Gemini suggested ${plan.files?.length ?? 0} files.`);
      return plan;
    }
  } catch (err) {
    console.warn("Gemini planning failed (likely due to UI change or timeout). Falling back to native heuristics:", err);
  } finally {
    await page.close().catch(() => {});
  }
  return null;
}

// ── Gemini prompt wrapper ──────────────────────────────────────────────────────
// This preamble is injected at the top of /tmp/contextForGemini.txt.
// It instructs Gemini to:
//   • Never truncate or summarise — reproduce ALL content verbatim
//   • Handle arbitrarily large (5k+ line) outputs
//   • Answer with full fidelity to the source material
const GEMINI_PREAMBLE = `\
SYSTEM INSTRUCTIONS FOR GEMINI — READ BEFORE PROCESSING ANY CONTENT BELOW
===========================================================================
You are operating as a deep-context analysis engine. The content below was
generated by NotebookLM from a large codebase or document set. It may be
extremely long (5,000–50,000+ lines). You MUST follow these rules without
exception:

1. NEVER truncate, summarise, omit, or paraphrase any section of the source
   content unless the user explicitly asks you to. Output completeness is the
   highest priority.

2. NEVER say "I'll skip the rest for brevity", "truncated for length",
   "continuing from previous context", or any equivalent phrase. There is NO
   length limit on your response. Generate until you are done.

3. When reproducing code, reproduce it character-for-character including all
   whitespace, comments, and blank lines.

4. When the user asks a question, answer it with full depth. Do not hedge
   with "given the large context…" — you have the full context below and
   must use ALL of it.

5. If you need to reference a specific file, function, or line number, cite
   it precisely from the content below. Do not approximate.

6. You are permitted and expected to produce responses that are tens of
   thousands of tokens long. Do not self-censor for response length.

===========================================================================
SOURCE CONTENT FROM NOTEBOOKLM BEGINS ON THE NEXT LINE:
===========================================================================

`;

// ── Brave binary resolution ────────────────────────────────────────────────────

function resolveBravePath(): string | undefined {
  const candidates = [
    "/usr/bin/brave-browser",
    "/usr/bin/brave",
    "/opt/brave.com/brave/brave",
    "/snap/bin/brave",
    "/usr/local/bin/brave",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  console.warn(
    "Brave not found — falling back to Playwright bundled Chromium.",
  );
  return undefined;
}

// ── Auth-state helpers ─────────────────────────────────────────────────────────

async function createAuthenticatedContext(
  executablePath: string | undefined,
): Promise<{
  browser: null; // Persistent context handles browser lifecycle
  context: BrowserContext;
}> {
  // Path to your actual Brave profile on Arch Linux
  // Standard location is ~/.config/BraveSoftware/Brave-Browser/Default
  const userDataDir = path.join(
    process.env.HOME || "",
    ".config/BraveSoftware/Brave-Browser/Default",
  );

  // We use launchPersistentContext to inherit your real login/cookies
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath,
    viewport: null, // Use your real screen size
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      // CRITICAL: This hides the 'Automation' flag from Google's security
      "--disable-blink-features=AutomationControlled",
    ],
    // This removes the "Chrome is being controlled by automated software" banner
    ignoreDefaultArgs: ["--enable-automation"],
  });

  return { browser: null, context };
}

async function saveAuthState(context: BrowserContext): Promise<void> {
  await context.storageState({ path: AUTH_STATE_PATH });
  console.info(`Auth state saved → ${AUTH_STATE_PATH}`);
}

// ── NotebookLM response scraper ────────────────────────────────────────────────

/**
 * Waits for NotebookLM to finish generating a response and scrapes the FULL
 * text content — no character limit.  Returns the raw string.
 */
async function scrapeNotebookLMResponse(page: Page): Promise<string> {
  console.info("Waiting for NotebookLM to generate a response…");

  // NotebookLM shows a "generating" spinner while it processes the upload.
  // We wait for it to disappear before scraping.
  const spinnerSelectors = [
    '[aria-label*="loading"]',
    '[aria-label*="Generating"]',
    ".generating-indicator",
    '[data-testid="loading-indicator"]',
    ".mat-progress-spinner",
    "mat-spinner",
  ];

  // Give the UI a moment to show the spinner before we wait for it to clear
  await page.waitForTimeout(2000);

  for (const sel of spinnerSelectors) {
    try {
      await page.waitForSelector(sel, { state: "hidden", timeout: 90_000 });
      break;
    } catch {
      // spinner didn't appear with this selector, try next
    }
  }

  // Additional settle time after spinner disappears
  await page.waitForTimeout(3000);

  // ── Collect ALL text content from the notebook ────────────────────────────
  // We prioritize the chat transcript for the most relevant answer.
  const contentSelectors = [
    ".chat-panel-content", 
    ".notebook-content",
    '[data-testid="notebook-content"]',
    ".source-content",
    ".overview-content",
    "main",
  ];

  let rawText = "";

  for (const sel of contentSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        // Use page.evaluate for unlimited-size text extraction
        rawText = await page.evaluate((selector: string) => {
          const node = document.querySelector(selector);
          if (!node) return "";

          // Walk the entire subtree collecting text, preserving newlines
          // from block-level elements so structure is maintained.
          const blockTags = new Set([
            "P",
            "DIV",
            "SECTION",
            "ARTICLE",
            "H1",
            "H2",
            "H3",
            "H4",
            "H5",
            "H6",
            "LI",
            "TD",
            "TH",
            "BLOCKQUOTE",
            "PRE",
            "CODE",
            "TR",
            "THEAD",
            "TBODY",
            "TABLE",
            "HEADER",
            "FOOTER",
            "ASIDE",
            "NAV",
            "MAIN",
            "FIGURE",
            "FIGCAPTION",
            "DETAILS",
            "SUMMARY",
          ]);

          function walk(n: Node, lines: string[]): void {
            if (n.nodeType === Node.TEXT_NODE) {
              const txt = n.textContent ?? "";
              if (txt.trim()) lines.push(txt);
              return;
            }
            if (n.nodeType !== Node.ELEMENT_NODE) return;

            const el = n as Element;
            const tag = el.tagName.toUpperCase();

            // Skip hidden elements
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden")
              return;

            if (blockTags.has(tag)) lines.push("\n");

            for (const child of Array.from(n.childNodes)) {
              walk(child, lines);
            }

            if (blockTags.has(tag)) lines.push("\n");
          }

          const lines: string[] = [];
          walk(node, lines);
          return lines
            .join("")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        }, sel);

        if (rawText.length > 200) {
          console.info(
            `Scraped ${rawText.length} characters from selector: ${sel}`,
          );
          break;
        }
      }
    } catch {
      // selector failed, try next
    }
  }

  if (!rawText || rawText.length < 100) {
    // Last resort — dump the entire visible page text
    console.warn(
      "Primary selectors returned little content — falling back to full page text.",
    );
    rawText = await page.evaluate(() => document.body.innerText ?? "");
  }

  return rawText;
}

// ── Write Gemini context file ─────────────────────────────────────────────────

function writeGeminiContextFile(notebookLMContent: string): void {
  const output = GEMINI_PREAMBLE + notebookLMContent;
  fs.writeFileSync(GEMINI_CONTEXT_PATH, output, { encoding: "utf8" });
  const lines = output.split("\n").length;
  const kb = (Buffer.byteLength(output, "utf8") / 1024).toFixed(1);
  console.info(
    `Gemini context written → ${GEMINI_CONTEXT_PATH}  (${lines} lines, ${kb} KB)`,
  );
}

// ── Core upload + scrape logic ────────────────────────────────────────────────

async function uploadToNotebookLMAndScrape(
  context: BrowserContext,
  absoluteFilePath: string,
  query: string,
): Promise<void> {
  if (!fs.existsSync(absoluteFilePath)) {
    throw new Error(`Context file not found at: ${absoluteFilePath}`);
  }

  const pages = context.pages();
  let page = pages.find((p) => p.url().includes("notebooklm.google.com"));

  if (page) {
    console.info("Reusing existing NotebookLM tab.");
    await page.bringToFront();
  } else {
    console.info("Opening new NotebookLM tab…");
    page = await context.newPage();
  }

  try {
    // ── 1. Navigate ──────────────────────────────────────────────────────────
    const currentUrl = page.url();
    const isInNotebook = currentUrl.includes("notebooklm.google.com/notebook/");
    
    if (!isInNotebook) {
      console.info("Navigating to NotebookLM home…");
      await page.goto(NOTEBOOKLM_URL, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });

      // ── 2. Google login guard ────────────────────────────────────────────────
      if (page.url().includes("accounts.google.com") || page.url().includes("signin")) {
        console.warn("Not authenticated — waiting for manual sign-in…");
        await page.waitForURL(/notebooklm\.google\.com/, { timeout: 90_000 });
      }

      // Brutally clear and PREVENT any blocking backdrops via CSS injection
      await page.addStyleTag({ 
        content: '.cdk-overlay-backdrop { display: none !important; pointer-events: none !important; }' 
      }).catch(() => {});
      
      await page.keyboard.press("Escape");
      await page.waitForTimeout(1000);

      // ── 3. New notebook ──────────────────────────────────────────────────────
      console.info("Creating new notebook…");
      const newNotebookBtn = page.locator('.create-new-action-button, button:has-text("Create new notebook"), button:has-text("New notebook")').first();
      await newNotebookBtn.waitFor({ state: "visible", timeout: 20_000 });
      await newNotebookBtn.click({ force: true });
      await page.waitForTimeout(2000);
    }

    // ── 4. Add source (Modal handling) ───────────────────────────────────────
    console.info("Clicking Add source…");
    await page.keyboard.press("Escape"); 
    
    // Attempt button click to open modal if not already open
    const addSourceBtn = page.locator('button[aria-label="Add source"], .add-source-button, button:has-text("Add source"), button:has-text("Add sources")').first();
    if (await addSourceBtn.isVisible().catch(() => false)) {
      await addSourceBtn.click({ force: true });
      await page.waitForTimeout(1500);
    }

    // ── 5. Ingestion Strategy: Fast Paste ────────────────────────────────────
    const contextContent = fs.readFileSync(absoluteFilePath, "utf8");
    const isSmallEnoughForPaste = contextContent.length < 500_000;

    if (isSmallEnoughForPaste) {
      console.info("Using 'Fast Paste' strategy for codebase context…");
      const pasteOptionBtn = page.locator('button.drop-zone-icon-button:has-text("Copied text"), button:has-text("Copied text"), [aria-label*="Copied text"]').first();
      await pasteOptionBtn.waitFor({ state: "visible", timeout: 15_000 });
      await pasteOptionBtn.click({ force: true });
      await page.waitForTimeout(1500);

      const pasteTextarea = page.locator('textarea[aria-label="Pasted text"], .copied-text-input-textarea, textarea').first();
      await pasteTextarea.waitFor({ state: "visible", timeout: 10_000 });
      
      // Inject via evaluate to handle large strings safely
      await pasteTextarea.evaluate((el, text) => {
        (el as HTMLTextAreaElement).value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, contextContent);
      await page.waitForTimeout(1000);

      const insertBtn = page.locator('button:has-text("Insert"), button:has-text("Add")').first();
      await insertBtn.click({ force: true });
    } else {
      console.info("Context too large for paste — using file upload…");
      const uploadOptionBtn = page.locator('[aria-label*="Upload files"], .drop-zone-icon-button, button:has-text("Upload files")').first();
      await uploadOptionBtn.waitFor({ state: "visible", timeout: 15_000 });
      await uploadOptionBtn.click({ force: true });
      await page.waitForTimeout(2000);

      const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 25_000 });
      const fileInput = page.locator('input[type="file"]').first();
      if ((await fileInput.count()) > 0) {
        await fileInput.setInputFiles(absoluteFilePath);
      } else {
        await page.locator('button:has-text("Browse"), .drop-zone-icon-button').first().click({ force: true });
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(absoluteFilePath);
      }

      await page.waitForTimeout(2000);
      const confirmBtn = page.locator('button:has-text("Insert"), button:has-text("Add"), button:has-text("Upload")').first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click({ force: true });
      }
    }

    // ── 8. Wait for ingestion and start chat ─────────────────────────────────
    console.info("Waiting for NotebookLM to ingest codebase context…");
    await page.waitForTimeout(4000); // Wait for ingestion to baseline
    await page.keyboard.press("Escape"); // Close the modal

    // ── 9. Chat with NotebookLM (Context Generation Phase) ───────────────────
    const contextReportPrompt = `Analyze the uploaded codebase. Your goal is NOT to answer a question for me, but to BUILD A MASTER CONTEXT block that I will pass to a 1-million-token Gemini model for final reasoning. 
    
    Extract and summarize:
    1. Core architecture patterns.
    2. Exact code logic and symbols relevant to this query: "${query}".
    3. Any deep implementation details that an expert AI needs to know to solve this.

    Format your response as a clean "Developer Context Block".`;
    
    console.info(`Instructing NotebookLM to build context for: "${query}"`);
    const chatInput = page.locator('textarea[aria-label*="Query box"], .query-box-input').first();
    const submitBtn = page.locator('button[aria-label*="Submit"], .submit-button').first();

    await chatInput.waitFor({ state: "visible", timeout: 25_000 });
    
    // Clear any overlays blocking the text area
    await page.evaluate(() => {
      document.querySelectorAll('.cdk-overlay-backdrop').forEach(b => (b as HTMLElement).style.display = 'none');
    }).catch(() => {});

    await chatInput.click({ force: true });
    await chatInput.fill(contextReportPrompt);
    await page.waitForTimeout(1000);
    
    console.info("Submitting query via keyboard Enter…");
    await page.keyboard.press("Enter");
    await submitBtn.click({ force: true }).catch(() => {});

    // ── 10. Wait for response and scrape ──────────────────────────────────────
    const notebookContent = await scrapeNotebookLMResponse(page);

    // ── 11. Write Gemini context file ─────────────────────────────────────────
    writeGeminiContextFile(notebookContent);

    // Refresh auth tokens
    await saveAuthState(context);
    console.info("Done. Browser left open for interaction.");
  } catch (err) {
    await saveAuthState(context).catch(() => {});
    throw err;
  }

  // Browser intentionally left open
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { query, repoContext } = body;

    if (!repoContext) {
      return NextResponse.json(
        { error: "Missing repoContext" },
        { status: 400 },
      );
    }

    const cached = getCachedFiles(repoContext.meta.fullName);
    if (!cached) {
      return NextResponse.json(
        { error: "File cache expired" },
        { status: 404 },
      );
    }

    const filesMetadata = Array.from(cached.files.values());
    const importGraph = cached.importGraph;

    // ── 1. Plan with Gemini (Expert Mode) ────────────────────────────────────
    let expertPlan = null;
    const executablePath = resolveBravePath();
    const browserContext = await getOrCreateContext(executablePath);
    
    try {
      expertPlan = await planWithGemini(browserContext, query, repoContext, filesMetadata);
    } catch (planErr) {
      console.warn("Expert planning phase failed, continuing with native mode.");
    }

    // ── 2. Build Master Context ──────────────────────────────────────────────
    let masterContext: string;
    try {
      masterContext = await buildMasterContext(
        query,
        filesMetadata,
        importGraph,
        repoContext,
        expertPlan,
      );
    } catch (err) {
      console.error("Bundler failed, falling back:", err);
      masterContext = buildFallbackContext(repoContext);
    }

    // ── Upload to NotebookLM, scrape response, write Gemini context ──────────
    try {
      await uploadToNotebookLMAndScrape(
        browserContext,
        CONTEXT_FILE_PATH,
        query,
      );
    } catch (browserErr) {
      console.warn(
        "Playwright automation failed.\n",
        "  Source file  →",
        CONTEXT_FILE_PATH,
        "\n",
        "  Gemini file  →",
        GEMINI_CONTEXT_PATH,
        "(may be incomplete)\n",
        browserErr,
      );
    }

    const geminiFileExists = fs.existsSync(GEMINI_CONTEXT_PATH);
    const geminiFileSizeKB = geminiFileExists
      ? (fs.statSync(GEMINI_CONTEXT_PATH).size / 1024).toFixed(1)
      : "0";

    return NextResponse.json({
      success: true,
      contextLocation: CONTEXT_FILE_PATH,
      geminiContextLocation: GEMINI_CONTEXT_PATH,
      geminiFileSizeKB,
      message: geminiFileExists
        ? `NotebookLM response scraped and saved to ${GEMINI_CONTEXT_PATH} (${geminiFileSizeKB} KB). Upload this file to Gemini — it contains the full no-truncation system prompt.`
        : "Automation partially failed — check server logs. Source file is intact.",
      queryToPaste: query,
    });
  } catch (error: any) {
    console.error("Route Error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
