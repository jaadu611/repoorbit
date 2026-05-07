import { Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CODE_EXTENSIONS = new Set([
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".rs",
  ".py",
  ".go",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".java",
  ".php",
  ".coffee",
  ".txt",
]);

// ─── Upload ───────────────────────────────────────────────────────────────────

async function uploadFiles(page: Page, filePaths: string[], logPrefix: string = "[Qwen]"): Promise<void> {
  const attemptUpload = async () => {
    console.log(`${logPrefix} Uploading ${filePaths.length} file(s) as a batch...`);

    const plusBtnSelector = [
      ".mode-select",
      '.message-input-container [class*="attach"]',
      ".qwen-chat-input-attach-btn",
      'button[aria-label*="Attach" i]',
      'button:has(svg[data-icon="plus"])',
      ".message-input-actions button:has(svg)",
    ].join(", ");

    const btn = await page.waitForSelector(plusBtnSelector, {
      timeout: 15_000,
    });
    const ariaLabel = await btn.getAttribute("aria-label");
    console.log(`${logPrefix} Using attach button: ${ariaLabel || "(no label)"}`);

    await page.click("textarea.message-input-textarea").catch(() => {});
    await btn.click({ force: true });
    await page.waitForTimeout(1000);

    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.waitForTimeout(500);

    const ITEM_SELS = [
      '.ant-dropdown-menu-item:has-text("Upload attachment")',
      '.mode-select-common-item:has-text("Upload attachment")',
      'li:has-text("Upload")',
      '.ant-dropdown-menu-item:has-text("Upload")',
      "text=/Upload/i",
    ];
    let foundSelector = "";
    for (const sel of ITEM_SELS) {
      const visible = await page
        .waitForSelector(sel, { timeout: 2000 })
        .catch(() => null);
      if (visible) {
        foundSelector = sel;
        break;
      }
    }
    if (!foundSelector) throw new Error("Upload menu item not visible");

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 20_000 }),
      (async () => {
        const target = page.locator(foundSelector).first();
        await target.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(500);
        try {
          await target.click({ force: true, timeout: 5000 });
        } catch (err: any) {
          console.warn(
            `[Qwen] Standard click failed, falling back to evaluate: ${err.message}`,
          );
          await page.evaluate((sel) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (el) el.click();
          }, foundSelector);
        }
      })(),
    ]);

    // Upload all files in this batch at once
    await fileChooser.setFiles(filePaths);

    console.log(
      `${logPrefix} Files submitted. Waiting for ${filePaths.length} chips to parse...`,
    );

    // Wait for the exact number of chips to appear AND for all loading indicators to vanish
    await page.waitForFunction(
      (expectedCount) => {
        const container =
          document.querySelector(
            '.message-input-container, .qwen-chat-input-container, [class*="input-container"], .qwen-chat-input',
          ) || document;

        const chips = container.querySelectorAll(
          '.anticon.fileitem-icon, .message-input-file-item, .ant-upload-list-item, [class*="file-item"], .qwen-chat-input-file-list-item',
        );

        const hasLoading = !!document.querySelector(
          '.ant-progress-bg, .ant-upload-list-item-uploading, [class*="uploading"], .ant-btn-loading, [class*="parsing"], .anticon-loading',
        );

        const allText = container.textContent?.toLowerCase() || "";
        const isStillParsing =
          allText.includes("parsing") || allText.includes("loading") || allText.includes("pending");

        const hasFailed = allText.includes("failed") || allText.includes("error");

        if (hasFailed && !isStillParsing) {
          // If we see "Failed" but nothing is "Parsing", it's a hard error
          throw new Error("FILE_PARSING_FAILED");
        }

        return (
          chips.length >= expectedCount && !hasLoading && !isStillParsing
        );
      },
      filePaths.length,
      { timeout: 150_000 },
    );

    await page.waitForTimeout(2000); // Settle time
  };

  let lastErr: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await attemptUpload();
      console.log(
        `[Qwen] Batch upload of ${filePaths.length} file(s) complete.`,
      );
      return;
    } catch (e: any) {
      lastErr = e;
      const isParsingError = e.message.includes("FILE_PARSING_FAILED");
      console.warn(
        `[Qwen] Upload attempt ${attempt} failed: ${e.message}${isParsingError ? " (Model-side parsing error)" : ""}.`,
      );
      if (attempt < 3) {
        console.log(`[Qwen] Reloading page to clear failed states and retrying (Attempt ${attempt + 1}/3)...`);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(5000); 
      }
    }
  }
  throw lastErr;
}

// ─── Send ─────────────────────────────────────────────────────────────────────

async function typeAndSend(page: Page, message: string): Promise<void> {
  const INPUT =
    ".message-input-textarea, textarea.message-input-textarea, textarea[placeholder*='message' i], [contenteditable='true']";
  console.log(`[Qwen] Typing message (${message.slice(0, 50)}...)...`);
  await page.waitForSelector(INPUT, { timeout: 15_000 });

  // Wait for input to be enabled
  await page
    .waitForFunction(
      (sel) => {
        const el = document.querySelector(sel) as HTMLTextAreaElement;
        return (
          el &&
          !el.disabled &&
          !el.readOnly &&
          !el.classList.contains("disabled")
        );
      },
      INPUT,
      { timeout: 30_000 },
    )
    .catch(() =>
      console.warn("[Qwen] Input field might be disabled, trying anyway..."),
    );

  await page.click(INPUT);

  if (message.length <= 50) {
    await page.type(INPUT, message, { delay: 1 });
  } else {
    await page.fill(INPUT, message);
  }

  const SEND_SEL =
    '.send-button, button.send-button, [class*="send-button"], button[aria-label*="Send" i], .qwen-chat-input-send-btn';
  console.log("[Qwen] Clicking send button...");
  const btn = await page.waitForSelector(SEND_SEL, {
    timeout: 10_000,
    state: "visible",
  });
  if (!btn) throw new Error("Send button not found");

  // Wait for button to be enabled (not disabled)
  await page.waitForFunction(
    (sel) => {
      const b = document.querySelector(sel) as HTMLButtonElement;
      return b && !b.disabled && !b.classList.contains("disabled");
    },
    SEND_SEL,
    { timeout: 30_000 },
  );
  // Re-locate and click immediately to avoid DOM detachment
  await page.click(SEND_SEL, { force: true });
  console.log("[Qwen] Message sent.");
}

// ─── Reply detection ──────────────────────────────────────────────────────────

const REPLY_SEL = ".response-message-content.phase-answer";

async function getReplyCount(page: Page): Promise<number> {
  return page.evaluate(
    (sel) => document.querySelectorAll(sel).length,
    REPLY_SEL,
  );
}

async function waitForReply(
  page: Page,
  countBefore: number,
  stallLimitMs: number,
): Promise<void> {
  console.log(
    `[Qwen] Waiting for reply (Qwen answers so far: ${countBefore})...`,
  );
  const deadline = Date.now() + 1_800_000; // 30 min hard limit
  let lastLog = Date.now();
  const startTime = Date.now();

  while (Date.now() < deadline) {
    const count = await getReplyCount(page);
    if (count > countBefore) {
      console.log(`[Qwen] New reply detected (count: ${count}).`);
      return;
    }

    // Stall check removed per user request: "qwen takes a long time to generate... but it never gets stuck"

    if (Date.now() - lastLog > 30000) {
      console.log(
        `[Qwen] Still waiting for reply (detected so far: ${count})...`,
      );
      lastLog = Date.now();
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("[Qwen] Timed out waiting for reply");
}

/**
 * Wait for the reply at a specific index to finish generating.
 */
async function waitForReplyCompletion(
  page: Page,
  targetIndex: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  let lastChange = Date.now();

  while (Date.now() < deadline) {
    const isGenerating = await page.evaluate(() => {
      const stopBtn = document.querySelector(
        '.qwen-chat-package-comp-new-action-control-container-stop, [class*="stop-generating"], button:has(svg[data-icon="stop"])',
      );
      if (stopBtn) return true;
      const bubbles = document.querySelectorAll(".response-message-content.phase-answer");
      const last = bubbles[bubbles.length - 1];
      if (last && last.querySelector(".anticon-loading, .ds-loading, .typing-dot"))
        return true;
      return false;
    });

    if (!isGenerating) {
      await page.waitForTimeout(2000); // Small extra wait to be sure
      return;
    }

    const currentText = await page.evaluate((idx) => {
      const bubbles = document.querySelectorAll(".response-message-content.phase-answer");
      const b = bubbles[idx] as HTMLElement | undefined;
      return b ? b.textContent || "" : "";
    }, targetIndex);

    if (currentText !== lastText) {
      lastText = currentText;
    }

    await page.waitForTimeout(2000);
  }
}

// ─── Extract response at a specific index ────────────────────────────────────
// FIX: previously extractResponse always grabbed the LAST bubble on the page,
// which could be a "Ready" from an intermediate batch.
// Now we snapshot the reply count BEFORE sending the final message and extract
// specifically the bubble at that index — guaranteed to be the final answer.

// QwenStallError removed per user request

async function extractResponseAtIndex(
  page: Page,
  targetIndex: number,
  stallLimitMs: number,
  logPrefix: string = "[Qwen]",
): Promise<string> {
  // Step 1: Wait for stop button to appear (generation started)
  await page
    .waitForFunction(
      () =>
        !!document.querySelector(
          '.qwen-chat-package-comp-new-action-control-container-stop, [class*="stop-generating"]',
        ),
      { timeout: 30_000 },
    )
    .catch(() => {
      // Fast responses may not show stop button — continue
    });

  // Step 2: Wait until generation is fully done
  const GENERATION_TIMEOUT_MS = 3_600_000; // 1 hour hard limit
  const deadline = Date.now() + GENERATION_TIMEOUT_MS;
  let lastSeenText = "";
  let lastChangeAt = Date.now();

  while (Date.now() < deadline) {
    // Check if generation finished
    const isGenerating = await page.evaluate(() => {
      const stopBtn = document.querySelector(
        '.qwen-chat-package-comp-new-action-control-container-stop, [class*="stop-generating"], button:has(svg[data-icon="stop"])',
      );
      if (stopBtn) return true;

      // Check if action controls (Copy, Regenerate) have appeared yet
      const actionControls = document.querySelector('.qwen-chat-package-comp-new-action-control-container-copy, .qwen-chat-package-comp-new-action-control-container');
      if (actionControls) return false; // If they are here, we are likely done

      // Check if there's a loading indicator in the latest assistant message
      const bubbles = document.querySelectorAll('.response-message-content.phase-answer');
      const last = bubbles[bubbles.length - 1];
      if (last && last.querySelector('.anticon-loading, .ds-loading, .typing-dot')) return true;

      return true; // Default to generating if neither stop nor actions are found
    });

    // Sample current partial output (including thinking blocks)
    const currentText = await page.evaluate(
      ({ sel, idx }: { sel: string; idx: number }) => {
        const els = document.querySelectorAll(sel);
        const bubble = els[idx] as HTMLElement | undefined;
        if (!bubble) return "";
        const think = bubble.querySelector('[class*="think"], [class*="reasoning"]');
        return (think ? (think as HTMLElement).textContent || "" : "") + (bubble.textContent || "");
      },
      { sel: REPLY_SEL, idx: targetIndex },
    );

    if (currentText !== lastSeenText) {
      lastSeenText = currentText;
      lastChangeAt = Date.now();
    }

    // Stall checks removed per user request: "remove all the time constraints from qwen"

    if (!isGenerating) break;

    // Auto-scroll to bottom to keep latest content in view
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
  }

  // Step 3: Settle pause
  await page.waitForTimeout(2000);

  // Step 4: Extract text from the specific bubble at targetIndex
  // Qwen sometimes splits long answers into multiple consecutive bubbles.
  const text = await page.evaluate(
    ({ sel, idx }: { sel: string; idx: number }) => {
      const els = document.querySelectorAll(sel);
      if (els.length === 0) return "";
      
      let combined = "";
      // Grab all bubbles from idx onwards (if they are assistant bubbles)
      for (let i = idx; i < els.length; i++) {
        const bubble = els[i] as HTMLElement;
        const clone = bubble.cloneNode(true) as HTMLElement;
        
        // Remove line numbers
        const lineNumbers = clone.querySelectorAll('.line-numbers, [class*="line-number"], .code-block-line-number');
        lineNumbers.forEach(el => el.remove());

        // Remove controls/buttons
        const controls = clone.querySelectorAll('.qwen-chat-package-comp-new-action-control-container, [class*="action-control"], button');
        controls.forEach(el => el.remove());

        combined += (combined ? "\n\n" : "") + (clone.innerText?.trim() ?? "");
      }
      return combined;
    },
    { sel: REPLY_SEL, idx: targetIndex },
  );

  // Additional post-processing to remove any lingering digit strings like "123456789101112"
  const cleanText = text.replace(/123456789\d*/g, "");

  console.log(
    `${logPrefix} Extracted response starting at index ${targetIndex} (${cleanText.length} chars)`,
  );
  return cleanText;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function askQwen(
  page: Page,
  query: string,
  contextDir: string,
  onStatus?: (msg: string, partial?: string, progress?: number) => void,
  outDir: string = "",
  isFirstTurn: boolean = true,
  logPrefix: string = "[Qwen]",
): Promise<string> {
  const context = page.context();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "https://chat.qwen.ai",
  });

  const qPage = page;

  if (!qPage.url().includes("chat.qwen.ai")) {
    onStatus?.("Navigating...");
    await qPage.goto("https://chat.qwen.ai/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await qPage.setViewportSize({ width: 1280, height: 1000 });
    await qPage.waitForTimeout(2_000);
  }

  await qPage.bringToFront();

  // ── Stage files ──────────────────────────────────────────────────────────────
  const sessionDir = path.join(os.tmpdir(), `qwen_upload_${Date.now()}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  const allTmpPaths: string[] = [];
  const addedFiles = new Set<string>();

  const addFile = (p: string) => {
    const base = path.basename(p);
    if (!addedFiles.has(base)) {
      allTmpPaths.push(p);
      addedFiles.add(base);
    }
  };

  if (fs.existsSync(contextDir)) {
    for (const fileName of fs.readdirSync(contextDir)) {
      const ext = path.extname(fileName).toLowerCase();
      if (
        !fileName.startsWith(".") &&
        (CODE_EXTENSIONS.has(ext) || ext === ".txt" || ext === ".json")
      ) {
        const src = path.join(contextDir, fileName);
        const dst = path.join(sessionDir, fileName);
        fs.writeFileSync(dst, fs.readFileSync(src, "utf-8"), "utf-8");
        addFile(dst);
      }
    }
  }

  // Root manifest is handled by the orchestration layer

  // ── Batch upload & send ──────────────────────────────────────────────────────
  const uniquePaths = Array.from(new Set(allTmpPaths));
  const BATCH_SIZE = 5;
  const batches: string[][] = [];
  for (let i = 0; i < uniquePaths.length; i += BATCH_SIZE) {
    batches.push(uniquePaths.slice(i, i + BATCH_SIZE));
  }

  if (batches.length === 0) {
    const countBefore = await getReplyCount(qPage);
    await typeAndSend(qPage, query);
    await waitForReply(qPage, countBefore, 300_000);
    return await extractResponseAtIndex(qPage, countBefore, 300_000, logPrefix);
  }

  onStatus?.(`Uploading ${uniquePaths.length} files in ${batches.length} batch(es)…`);

  for (let i = 0; i < batches.length; i++) {
    const isLast = i === batches.length - 1;
    onStatus?.(`[Batch ${i + 1}/${batches.length}] Uploading…`);
    console.log(
      `${logPrefix} Batch ${i + 1}/${batches.length}:`,
      batches[i].map((p) => path.basename(p)),
    );

    await uploadFiles(qPage, batches[i], logPrefix);

    if (isLast) {
      const msg =
        batches.length > 1
          ? `[FINAL PART ${i + 1}/${batches.length}] All context uploaded. Analyze and solve: ${query}`
          : query;

      const finalReplyIndex = await getReplyCount(qPage);
      onStatus?.(`[Batch ${i + 1}/${batches.length}] Sending final query…`);
      await typeAndSend(qPage, msg);
      onStatus?.(`[Batch ${i + 1}/${batches.length}] Waiting for final answer…`);
      await waitForReply(qPage, finalReplyIndex, 300_000);
      onStatus?.(`[Batch ${i + 1}/${batches.length}] Extracting response…`);
      return await extractResponseAtIndex(
        qPage,
        finalReplyIndex,
        300_000,
        logPrefix,
      );
    } else {
      const replyCountBefore = await getReplyCount(qPage);
      onStatus?.(`[Batch ${i + 1}/${batches.length}] Acknowledging part…`);
      await typeAndSend(
        qPage,
        `Context Part ${i + 1}/${batches.length} attached. Wait for the next part. Reply only "Ready".`,
      );
      await waitForReply(qPage, replyCountBefore, 300_000);
      onStatus?.(`[Batch ${i + 1}/${batches.length}] Finalizing acknowledgment…`);
      await waitForReplyCompletion(qPage, replyCountBefore, 60_000);
      console.log(`${logPrefix} Batch ${i + 1} acknowledged. Settling...`);
      await qPage.waitForTimeout(8000); // Increased settlement
    }
  }

  return "";
}
