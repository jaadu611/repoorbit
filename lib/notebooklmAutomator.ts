import { Page } from "playwright";
import path from "path";
import fs from "fs";
import { getArchitectPrompt } from "./prompts";

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

function extractPartial(rawText: string): string | null {
  let partial = rawText;

  const hasStart = partial.includes("STARTOFANS");
  const hasEnd = partial.includes("ENDOFANS");

  if (hasStart) {
    partial = partial.split("STARTOFANS")[1] || "";
  }
  if (hasEnd) {
    partial = partial.split("ENDOFANS")[0];
  }

  partial = partial.trim();
  return partial.length > 20 ? partial : null;
}

export async function automateNotebookLM(
  page: Page,
  files: string[],
  query: string,
  repoName: string,
  onStatus?: (msg: string, partial?: string, progress?: number) => void,
): Promise<string> {
  const notebookTitle = `@RepoOrbit: ${repoName}`;
  let url = page.url();

  if (url.includes("/notebook/")) {
    await page.waitForTimeout(1000);
    const currentTitle = await page.title();
    if (!currentTitle.includes(notebookTitle)) {
      onStatus?.("Switching notebooks...");
      await page.goto("https://notebooklm.google.com/", {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      url = page.url();
      await page.waitForTimeout(2000);
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

  onStatus?.("Checking existing sources...");
  await page.waitForTimeout(2000);
  const domHTML = await page.evaluate(() => document.body.innerText || "");

  const filesToUpload = files.filter((file) => {
    const baseName = path.basename(file);
    const baseNoExt = baseName.replace(".txt", "");
    return !domHTML.includes(baseName) && !domHTML.includes(baseNoExt);
  });

  if (filesToUpload.length > 0) {
    onStatus?.(
      `Syncing ${filesToUpload.length} context file${filesToUpload.length !== 1 ? "s" : ""}...`,
    );
    const uploadIconBtnSelector =
      'button.drop-zone-icon-button, button:has-text("Upload files"), [aria-label*="Upload files"]';

    const BATCH_SIZE = 100;
    const MAX_BATCH_SIZE_BYTES = 1000 * 1024 * 1024;

    const batches: string[][] = [];
    let currentBatch: string[] = [];
    let currentBatchSizeBytes = 0;

    for (const file of filesToUpload) {
      let fileSize = 0;
      try {
        const stats = fs.statSync(file);
        fileSize = stats.size;
      } catch (e) {}

      if (
        currentBatch.length > 0 &&
        (currentBatch.length >= BATCH_SIZE ||
          currentBatchSizeBytes + fileSize > MAX_BATCH_SIZE_BYTES)
      ) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBatchSizeBytes = 0;
      }

      currentBatch.push(file);
      currentBatchSizeBytes += fileSize;
    }
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    let uploadedCount = 0;
    for (const batch of batches) {
      if (batch.length === 0) continue;

      const uploadIconBtn = page.locator(uploadIconBtnSelector).first();
      let isModalOpen = await uploadIconBtn.isVisible().catch(() => false);

      if (!isModalOpen) {
        const addSourceBtn = page
          .locator(
            '.add-source-button, [aria-label="Add source"], button:has-text("Add source")',
          )
          .first();
        if (
          await addSourceBtn.isVisible({ timeout: 10000 }).catch(() => false)
        ) {
          await addSourceBtn.click({ force: true });
          await page.waitForTimeout(2000);
        }
      }

      // Retry file chooser if it times out or fails (NotebookLM processing might block UI)
      let fileChooserSuccess = false;
      let retries = 15; // Increased retries for heavy processing
      while (!fileChooserSuccess && retries > 0) {
        try {
          // Ensure button is ready
          await uploadIconBtn.waitFor({ state: "visible", timeout: 5000 });
          await uploadIconBtn.scrollIntoViewIfNeeded();
          await page.waitForTimeout(400); // Wait for animations to settle

          // Attempt to trigger the file chooser
          const [fileChooser] = await Promise.all([
            page.waitForEvent("filechooser", { timeout: 20000 }),
            uploadIconBtn.click({ force: true, delay: 100 }),
          ]);

          await page.waitForTimeout(500);

          try {
            await fileChooser.setFiles(batch);
            fileChooserSuccess = true;
          } catch (err: any) {
            if (err.message.includes("transfer files larger than 50Mb")) {
              console.log("[NotebookLM automator] Hit 50MB limit on CDP. Bypassing via native CDP command...");
              try {
                // If it's a remote connection over CDP to localhost, we can tell 
                // the browser to just read the local paths directly using the native CDP protocol.
                const client = await page.context().newCDPSession(page);
                const { root } = await client.send("DOM.getDocument");
                const { nodeId } = await client.send("DOM.querySelector", {
                  nodeId: root.nodeId,
                  selector: "input[type=\"file\"]"
                });
                if (nodeId) {
                  await client.send("DOM.setFileInputFiles", {
                    files: batch,
                    nodeId
                  });
                  fileChooserSuccess = true;
                  console.log("[NotebookLM automator] Native CDP bypass successful.");
                } else {
                  throw new Error("Could not find file input element via native CDP.");
                }
              } catch (cdpErr: any) {
                console.error(`[NotebookLM automator] Native CDP bypass failed: ${cdpErr.message}`);
                throw err; // Re-throw original upload error
              }
            } else {
              throw err;
            }
          }
        } catch (err: any) {
          retries--;
          await page.waitForTimeout(4000);
          console.warn(
            `[NotebookLM automator] fileChooser attempt failed: ${err.message}. Retrying... (${retries} left)`,
          );

          // If button is gone but we didn't succeed, the modal might have closed
          const stillVisible = await uploadIconBtn
            .isVisible()
            .catch(() => false);
          if (!stillVisible) {
            console.log(
              "[NotebookLM automator] Modal closed unexpectedly. Re-opening...",
            );
            const addSourceBtn = page
              .locator(
                '.add-source-button, [aria-label="Add source"], button:has-text("Add source")',
              )
              .first();
            if (await addSourceBtn.isVisible().catch(() => false)) {
              await addSourceBtn.click({ force: true });
              await page.waitForTimeout(3000);
            }
          }
        }
      }

      if (!fileChooserSuccess) {
        console.warn(
          "[NotebookLM automator] Unable to trigger file upload dialog after multiple attempts. Likely hit NotebookLM's 50-source limit. Proceeding with currently uploaded sources...",
        );
        onStatus?.(
          `Hit source limit. Proceeding with ${uploadedCount} files...`,
          undefined,
          Math.round((uploadedCount / filesToUpload.length) * 100),
        );
        break; // Break the batch loop gracefully
      }

      uploadedCount += batch.length;
      onStatus?.(
        `Ingesting files... (${uploadedCount}/${filesToUpload.length})`,
        undefined,
        Math.round((uploadedCount / filesToUpload.length) * 100),
      );

      // reduced wait for fast batches
      await page.waitForTimeout(2000);
    }

    onStatus?.("Processing uploaded sources...");
    const closeBtn = page
      .locator('button[aria-label="Close"], .close-button')
      .first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ force: true });
    }
    await page.waitForTimeout(4000);
  }

  onStatus?.("Dispatching query...");
  const architectPrompt = getArchitectPrompt(query);

  const existingResponseSnapshotSnippet: string[] = await page.evaluate(`
    (() => {
      function findDeep(selector, root = document) {
        let els = Array.from(root.querySelectorAll(selector));
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) els = els.concat(findDeep(selector, el.shadowRoot));
        }
        return els;
      }
      const actionButtons = findDeep('button[aria-label*="Copy"], button[aria-label*="Save"], button[aria-label*="note"]');
      const containers = actionButtons
        .map((btn) => btn.closest(".message-content, .model-response, .response-bubble, div"))
        .filter(Boolean);
      const aiContainers = findDeep('div:has(> button[aria-label*="Copy"]), div:has(> button[aria-label*="Save"]), .model-response');
      const all = [...new Set([...aiContainers, ...containers])];
      return all.map((el) => el.innerText.trim().substring(0, 200));
    })()
  `);

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
    const candidate = await page.evaluate<{
      text: string;
      isGenerating: boolean;
    } | null>(`
      ((snapshot) => {
        function findElementsDeep(selector, root = document) {
          let elements = Array.from(root.querySelectorAll(selector));
          for (const el of root.querySelectorAll("*")) {
            if (el.shadowRoot) {
              elements = elements.concat(findElementsDeep(selector, el.shadowRoot));
            }
          }
          return elements;
        }

        const isGenerating = findElementsDeep('.loading-indicator, [aria-label*="Generating"], .generating, .response-loading').length > 0;

        const actionButtons = findElementsDeep('button[aria-label*="Copy"], button[aria-label*="Save"], button[aria-label*="note"]');
        const bubblesWithButtons = actionButtons
          .map((btn) => btn.closest(".message-content, .model-response, .response-bubble, div"))
          .filter((b) => b !== null);

        const aiResponseContainers = findElementsDeep('div:has(> button[aria-label*="Copy"]), div:has(> button[aria-label*="Save"]), .model-response');

        const candidates = [...new Set([...aiResponseContainers, ...bubblesWithButtons])];

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
      })(${JSON.stringify(existingResponseSnapshotSnippet)})
    `);

    if (candidate) {
      const rawText = candidate.text;
      const hasEnd = rawText.includes("ENDOFANS");

      const partial = extractPartial(rawText);

      if (hasEnd) {
        const finalText = partial ?? cleanScrapedText(rawText);
        onStatus?.("Capturing final response...", finalText);
        return cleanScrapedText(finalText);
      }

      if (partial) {
        onStatus?.("Generating...", partial);
      } else {
        onStatus?.("Synthesizing response...");
      }

      const currentLength = rawText.length;
      if (currentLength === lastSeenLength && !candidate.isGenerating) {
        stableCount++;
        if (stableCount >= STABLE_POLLS_NEEDED) {
          return cleanScrapedText(partial ?? rawText);
        }
      } else {
        stableCount = 0;
        lastSeenLength = currentLength;
      }
    }

    await page.waitForTimeout(1000);
  }

  throw new Error("Analysis timeout (5m)");
}
