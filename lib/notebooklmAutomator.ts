import { chromium, Browser, BrowserContext, Page } from "playwright";
import fs from "fs";
import path from "path";
import { getArchitectPrompt } from "./prompts";

const CDP_URL = "http://127.0.0.1:9222";

const UI_JUNK_LABELS = [
  "keep_pin",
  "Save to note",
  "copy_all",
  "thumb_up",
  "thumb_down",
  "more_horiz",
  "content_copy",
  "bookmark",
  "share",
];

function cleanScrapedText(raw: string): string {
  const UI_JUNK_LABELS = [
    "keep_pin",
    "Save to note",
    "copy_all",
    "thumb_up",
    "thumb_down",
    "more_horiz",
    "content_copy",
    "bookmark",
    "share",
  ];

  const lines = raw.split("\n");

  let trailingQuestionStart = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === "" || t.endsWith("?")) {
      trailingQuestionStart = i;
    } else {
      break;
    }
  }

  return lines
    .slice(0, trailingQuestionStart)
    .filter((line) => {
      const t = line.trim();
      if (UI_JUNK_LABELS.includes(t)) return false;
      if (/^[-*_]{3,}$/.test(t)) return false;
      if (/^\d{1,2}$/.test(t)) return false;
      if (/^[.,;:]{1,2}$/.test(t)) return false; 
      return true;
    })
    .join("\n")
    .replace(/(\S)\d{1,2}(\s)/g, "$1$2") 
    .replace(/(\S)\d{1,2}$/gm, "$1") 
    .replace(/\n{3,}/g, "\n\n") 
    .trim();
}

export async function automateNotebookLM(
  page: Page,
  files: string[],
  query: string,
  repoName: string,
  onStatus?: (msg: string) => void,
): Promise<string> {

  const notebookTitle = `@RepoOrbit: ${repoName}`;
  let url = page.url();
  let shouldUploadSources = true;

  if (url.includes("/notebook/")) {
    await page.waitForTimeout(1000); 
    const currentTitle = await page.title();
    if (!currentTitle.includes(notebookTitle)) {
      onStatus?.("Switching to different repo notebook...");
      await page.goto("https://notebooklm.google.com/", {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      url = page.url();
      await page.waitForTimeout(2000);
    } else {
      shouldUploadSources = false;
    }
  }

  if (!url.includes("/notebook/")) {
    onStatus?.("Connecting to NotebookLM...");
    const notebookBtn = page
      .locator(
        `div[role="button"]:has-text("${notebookTitle}"), mat-card:has-text("${notebookTitle}")`,
      )
      .first();

    if (await notebookBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      onStatus?.("Opening existing notebook...");
      await notebookBtn.click({ force: true });
      shouldUploadSources = false;
    } else {
      onStatus?.("Creating new notebook...");
      const createBtn = page
        .locator(
          'button.create-new-button, [aria-label*="Create new notebook"], .create-new-action-button',
        )
        .first();
      await createBtn.waitFor({ state: "visible", timeout: 20000 });
      await createBtn.click({ force: true });

      await page.waitForURL((u) => u.href.includes("/notebook/"), {
        timeout: 30000,
      });
      await page.waitForTimeout(3000); 

      const titleEditTrigger = page
        .locator(
          '[aria-label*="Rename notebook"], .notebook-title-edit, span:has-text("Untitled notebook"), h2:has-text("Untitled notebook")',
        )
        .first();

      if (await titleEditTrigger.isVisible().catch(() => false)) {
        await titleEditTrigger.click({ force: true });
        await page.waitForTimeout(500); 
      }

      const titleInput = page
        .locator(
          'input[aria-label*="title"], input.title-input, textarea.title-input, input[value="Untitled notebook"]',
        )
        .first();

      if (await titleInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await titleInput.fill(notebookTitle);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1000);
      }
    }
  }

  if (shouldUploadSources) {
    onStatus?.("Checking existing sources...");
    const filesToUpload: string[] = files; 

    if (filesToUpload.length > 0) {
      onStatus?.(
        `Uploading ${filesToUpload.length} context file${filesToUpload.length !== 1 ? "s" : ""}...`,
      );
      const uploadIconBtn = page
        .locator(
          'button.drop-zone-icon-button, button:has-text("Upload files"), [aria-label*="Upload files"]',
        )
        .first();

      const initialCount = await page.evaluate(() => {
        const counter = document.querySelector(".sources-count-text");
        if (counter)
          return parseInt(counter.textContent!.split("/")[0].trim()) || 0;
        return document.querySelectorAll("button.source-stretched-button")
          .length;
      });

      const BATCH_SIZE = 15;
      for (let i = 0; i < filesToUpload.length; i += BATCH_SIZE) {
        const batch = filesToUpload.slice(i, i + BATCH_SIZE);

        let isModalOpen = await uploadIconBtn.isVisible().catch(() => false);
        if (!isModalOpen) {
          const addSourceBtn = page
            .locator(
              '.add-source-button, [aria-label="Add source"], button:has-text("Add source")',
            )
            .first();
          await addSourceBtn.waitFor({ state: "visible", timeout: 30000 });
          await addSourceBtn.click({ force: true });
          await page.waitForTimeout(2000);
        }

        const [fileChooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 30000 }),
          uploadIconBtn.click({ force: true }),
        ]);
        await fileChooser.setFiles(batch);
        onStatus?.(
          `Uploading context files... (${Math.min(i + BATCH_SIZE, filesToUpload.length)}/${filesToUpload.length})`,
        );
        await page.waitForTimeout(4000); 
      }

      const targetCount = initialCount + filesToUpload.length;
      const uploadStartTime = Date.now();
      while (Date.now() - uploadStartTime < 300000) {

        const currentCount = await page.evaluate(() => {
          const counter = document.querySelector(".sources-count-text");
          if (counter)
            return parseInt(counter.textContent!.split("/")[0].trim()) || 0;
          return document.querySelectorAll("button.source-stretched-button")
            .length;
        });
        if (currentCount >= targetCount) break;
        await page.waitForTimeout(4000);
      }

      onStatus?.("Processing uploaded sources...");
      const closeBtn = page
        .locator('button[aria-label="Close"], .close-button')
        .first();
      if (await closeBtn.isVisible()) await closeBtn.click();
      await page.waitForTimeout(4000);
    }
  }

  onStatus?.("Submitting your query...");
  const architectPrompt = getArchitectPrompt(query);

  const existingResponseSnapshot: Set<string> = await page.evaluate(() => {
    function findDeep(selector: string, root: any = document): HTMLElement[] {
      let els: HTMLElement[] = Array.from(root.querySelectorAll(selector));
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) els = els.concat(findDeep(selector, el.shadowRoot));
      }
      return els;
    }
    const actionButtons = findDeep(
      'button[aria-label*="Copy"], button[aria-label*="Save"], button[aria-label*="note"]',
    );
    const containers = actionButtons
      .map((btn) =>
        btn.closest(".message-content, .model-response, .response-bubble, div"),
      )
      .filter(Boolean) as HTMLElement[];
    const aiContainers = findDeep(
      'div:has(> button[aria-label*="Copy"]), div:has(> button[aria-label*="Save"]), .model-response',
    );
    const all = [...new Set([...aiContainers, ...containers])];
    return new Set(
      all.map((el) => (el as HTMLElement).innerText.trim().substring(0, 200)),
    );
  });

  const inputSelector =
    'textarea[placeholder*="Ask"], .chat-input textarea, textarea[aria-label*="Query"]';
  await page.waitForSelector(inputSelector, { timeout: 30000 });
  await page.fill(inputSelector, architectPrompt);
  await page.keyboard.press("Enter");

  onStatus?.("Waiting for AI to respond...");
  const startTime = Date.now();

  let lastSeenLength = 0;
  let stableCount = 0;
  const STABLE_POLLS_NEEDED = 2; 

  while (Date.now() - startTime < 300000) {
    const candidate = await page.evaluate((snapshot) => {

      function findElementsDeep(
        selector: string,
        root: any = document,
      ): HTMLElement[] {
        let elements: HTMLElement[] = Array.from(
          root.querySelectorAll(selector),
        );
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot)
            elements = elements.concat(
              findElementsDeep(selector, el.shadowRoot),
            );
        }
        return elements;
      }

      const isGenerating =
        findElementsDeep(
          '.loading-indicator, [aria-label*="Generating"], .generating, .response-loading',
        ).length > 0;

      const actionButtons = findElementsDeep(
        'button[aria-label*="Copy"], button[aria-label*="Save"], button[aria-label*="note"]',
      );
      const bubblesWithButtons = actionButtons
        .map((btn) =>
          btn.closest(
            ".message-content, .model-response, .response-bubble, div",
          ),
        )
        .filter((b) => b !== null) as HTMLElement[];

      const aiResponseContainers = findElementsDeep(
        'div:has(> button[aria-label*="Copy"]), div:has(> button[aria-label*="Save"]), .model-response',
      );

      const candidates = [
        ...new Set([...aiResponseContainers, ...bubblesWithButtons]),
      ];

      const newResponses = candidates.filter((el) => {
        const preview = el.innerText.trim().substring(0, 200);
        return !snapshot.includes(preview);
      });

      const substantive = newResponses
        .map((b) => b.innerText.trim())
        .filter((t) => t.length > 100);

      if (substantive.length > 0) {
        return { text: substantive[substantive.length - 1], isGenerating };
      }
      return null;
    }, Array.from(existingResponseSnapshot));

    if (candidate) {
      const currentLength = candidate.text.length;

      if (currentLength === lastSeenLength && !candidate.isGenerating) {
        stableCount++;
        onStatus?.(
          `Capturing response... (${stableCount}/${STABLE_POLLS_NEEDED})`,
        );
        if (stableCount >= STABLE_POLLS_NEEDED) {

          const cleaned = cleanScrapedText(candidate.text);
          return cleaned;
        }
      } else {

        stableCount = 0;
        lastSeenLength = currentLength;
        onStatus?.("Streaming response...");
      }
    }

    await page.waitForTimeout(5000);
  }

  throw new Error("Analysis timeout (5m)");
}

export async function askNotebookLM(
  repoName: string,
  prompt: string,
  sourcesDir: string,
): Promise<string> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    const profilePath = path.join(process.cwd(), ".notebooklm-profile");
    context = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    const pages = context?.pages() || [];
    page = pages.find((p) => p.url().includes("notebooklm.google.com")) || null;

    if (!page) {
      page = await context!.newPage();
      await page.goto("https://notebooklm.google.com/", {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
    }

    if (!page) throw new Error("Could not create or find a NotebookLM page.");

    const files = fs
      .readdirSync(sourcesDir)
      .filter((f) => f.endsWith(".txt"))
      .map((f) => path.join(sourcesDir, f))
      .sort();

    return await automateNotebookLM(page, files, prompt, repoName);
  } finally {

  }
}
