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

async function uploadFiles(page: Page, filePaths: string[]): Promise<void> {
  const attemptUpload = async () => {
    console.log(`[Qwen] Uploading ${filePaths.length} file(s) as a batch...`);

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
    console.log(`[Qwen] Using attach button: ${ariaLabel || "(no label)"}`);

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
      `[Qwen] Files submitted. Waiting for ${filePaths.length} chips to parse...`,
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

  await btn.click({ force: true });
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

    if (Date.now() - startTime > stallLimitMs) {
      console.warn(`[Qwen] No reply started after ${stallLimitMs / 1000}s — reloading page.`);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(3_000);
      throw new QwenStallError(`[Qwen] No reply started after ${stallLimitMs / 1000}s.`);
    }

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

// ─── Extract response at a specific index ────────────────────────────────────
// FIX: previously extractResponse always grabbed the LAST bubble on the page,
// which could be a "Ready" from an intermediate batch.
// Now we snapshot the reply count BEFORE sending the final message and extract
// specifically the bubble at that index — guaranteed to be the final answer.

class QwenStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QwenStallError";
  }
}

async function extractResponseAtIndex(
  page: Page,
  targetIndex: number,
  stallLimitMs: number,
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

  // Step 2: Wait until generation is fully done — with a stall watchdog
  const STALL_LIMIT_MS = stallLimitMs;
  const GENERATION_TIMEOUT_MS = 300_000;
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

      // Check if there's a loading indicator in the latest assistant message
      const bubbles = document.querySelectorAll('.response-message-content.phase-answer');
      const last = bubbles[bubbles.length - 1];
      if (last && last.querySelector('.anticon-loading, .ds-loading, .typing-dot')) return true;

      return false;
    });

    // Sample current partial output (including thinking blocks)
    const currentText = await page.evaluate(
      ({ sel, idx }: { sel: string; idx: number }) => {
        const els = document.querySelectorAll(sel);
        const bubble = els[idx] as HTMLElement | undefined;
        if (!bubble) return "";
        const think = bubble.querySelector('[class*="think"], [class*="reasoning"]');
        return (think ? (think as HTMLElement).innerText : "") + bubble.innerText;
      },
      { sel: REPLY_SEL, idx: targetIndex },
    );

    if (currentText !== lastSeenText) {
      lastSeenText = currentText;
      lastChangeAt = Date.now();
    }

    const stalledMs = Date.now() - lastChangeAt;

    // --- NEW: Stable Text Fallback ---
    // If the text is long (>500 chars) and hasn't changed for 45s, 
    // even if isGenerating is true, we consider it done. 
    // This handles "ghost" stop buttons.
    if (stalledMs >= 45_000 && currentText.length > 500) {
      console.log(`[Qwen] Text stable for 45s and looks complete (${currentText.length} chars). Finishing.`);
      break;
    }

    if (stalledMs >= STALL_LIMIT_MS && isGenerating) {
      console.warn(`[Qwen] No output change for ${stalledMs / 1000}s — ignoring stall per user request.`);
      // No reload, no error — just keep waiting
      lastChangeAt = Date.now(); // Reset watchdog to avoid spamming logs
    }

    if (!isGenerating) break;
    // Auto-scroll to bottom to keep latest content in view
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2_000);
  }

  // Step 3: Settle pause
  await page.waitForTimeout(2000);

  // Step 4: Extract text from the specific bubble at targetIndex
  const text = await page.evaluate(
    ({ sel, idx }: { sel: string; idx: number }) => {
      const els = document.querySelectorAll(sel);
      const bubble = els[idx] as HTMLElement | undefined;
      if (!bubble) return "";

      const clone = bubble.cloneNode(true) as HTMLElement;
      const ignoreEls = clone.querySelectorAll(
        ".qwen-chat-package-comp-new-action-control-container-copy .qwen-chat-package-comp-new-action-control-container",
      );
      ignoreEls.forEach((el) => el.remove());
      return clone.innerText?.trim() ?? "";
    },
    { sel: REPLY_SEL, idx: targetIndex },
  );

  console.log(
    `[Qwen] Extracted response at index ${targetIndex} (${text.length} chars)`,
  );
  return text;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function askQwen(
  page: Page,
  query: string,
  contextDir: string,
  onStatus?: (msg: string, partial?: string, progress?: number) => void,
  outDir: string = "",
  isFirstTurn: boolean = true,
): Promise<string> {
  const context = page.context();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "https://chat.qwen.ai",
  });

  const qPage = page;

  if (!qPage.url().includes("chat.qwen.ai")) {
    onStatus?.("Navigating to Qwen AI…");
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

  if (isFirstTurn) {
    const metadataBase =
      outDir && fs.existsSync(outDir) ? outDir : process.cwd();

    const rootManifest = path.join(metadataBase, "00_Root_Manifest.txt");
    if (fs.existsSync(rootManifest)) {
      const dst = path.join(sessionDir, "00_Root_Manifest.txt");
      fs.writeFileSync(dst, fs.readFileSync(rootManifest, "utf-8"), "utf-8");
      addFile(dst);
    }
  }

  // ── Batch upload & send ──────────────────────────────────────────────────────
  const uniquePaths = Array.from(new Set(allTmpPaths));
  const BATCH_SIZE = 5;
  const batches: string[][] = [];
  for (let i = 0; i < uniquePaths.length; i += BATCH_SIZE) {
    batches.push(uniquePaths.slice(i, i + BATCH_SIZE));
  }

  if (batches.length === 0) {
    let currentStallLimit = 300_000;
    while (true) {
      try {
        const countBefore = await getReplyCount(qPage);
        await typeAndSend(qPage, query);
        await waitForReply(qPage, countBefore, currentStallLimit);
        return await extractResponseAtIndex(qPage, countBefore, currentStallLimit);
      } catch (e: any) {
        if (e instanceof QwenStallError) {
          console.warn(`[Qwen] Stall detected. Retrying with increased timeout: ${currentStallLimit / 1000 + 30}s.`);
          currentStallLimit += 30_000;
          await qPage.waitForTimeout(2_000);
          continue;
        }
        throw e;
      }
    }
  }

  onStatus?.(
    `Uploading ${uniquePaths.length} files in ${batches.length} batch(es)…`,
  );

  for (let i = 0; i < batches.length; i++) {
    const isLast = i === batches.length - 1;
    onStatus?.(`[Batch ${i + 1}/${batches.length}] Uploading…`);
    console.log(
      `[Qwen] Batch ${i + 1}/${batches.length}:`,
      batches[i].map((p) => path.basename(p)),
    );

    await uploadFiles(qPage, batches[i]);

    if (isLast) {
      const msg =
        batches.length > 1
          ? `[FINAL PART ${i + 1}/${batches.length}] All context uploaded. Analyze and solve: ${query}`
          : query;

      // Snapshot BEFORE sending — this index is exactly where the final answer will land
      let currentStallLimit = 300_000;
      while (true) {
        try {
          const finalReplyIndex = await getReplyCount(qPage);
          onStatus?.("Qwen: Typing final query…");
          await typeAndSend(qPage, msg);
          onStatus?.("Qwen: Waiting for reply…");
          await waitForReply(qPage, finalReplyIndex, currentStallLimit);
          onStatus?.("Qwen: Extracting response…");
          return await extractResponseAtIndex(qPage, finalReplyIndex, currentStallLimit);
        } catch (e: any) {
          if (e instanceof QwenStallError) {
            console.warn(`[Qwen] Stall detected on final batch. Retrying with increased timeout: ${currentStallLimit / 1000 + 30}s.`);
            currentStallLimit += 30_000;
            await qPage.waitForTimeout(2_000);
            continue;
          }
          throw e;
        }
      }
    } else {
          const replyCountBefore = await getReplyCount(qPage);
          await typeAndSend(
            qPage,
            `Context Part ${i + 1}/${batches.length} attached. Wait for the next part. Reply only "Ready".`,
          );
          await waitForReply(qPage, replyCountBefore, 300_000); // Wait 300s for "Ready" acknowledgement
          console.log(`[Qwen] Batch ${i + 1} acknowledged. Settling...`);
      await qPage.waitForTimeout(5000);
    }
  }

  return "";
}
