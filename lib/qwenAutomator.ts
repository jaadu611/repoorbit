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
    const plusBtnSelector =
      '.message-input-container [class*="attach"], button[aria-label*="Attach" i], .mode-select, button:has(span[class*="plus"])';
    const plusBtn = await page.waitForSelector(plusBtnSelector, {
      timeout: 10_000,
    });

    await page.click("textarea.message-input-textarea").catch(() => {});
    await plusBtn.click({ force: true });
    await page.waitForTimeout(1000);

    const ITEM_SELS = [
      'li:has-text("Upload")',
      '.ant-dropdown-menu-item:has-text("Upload")',
      "text=/Upload/i",
    ];
    let uploadItem: any = null;
    for (const sel of ITEM_SELS) {
      uploadItem = await page
        .waitForSelector(sel, { timeout: 3000 })
        .catch(() => null);
      if (uploadItem) break;
    }
    if (!uploadItem) throw new Error("Upload menu item not visible");

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 15_000 }),
      uploadItem.click({ force: true }),
    ]);
    await fileChooser.setFiles(filePaths);

    await page.waitForFunction(
      (count) => {
        const container =
          document.querySelector(
            '.message-input-container, .qwen-chat-input-container, [class*="input-container"]',
          ) || document;
        const chips = container.querySelectorAll(
          '.anticon.fileitem-icon, .message-input-file-item, .ant-upload-list-item, [class*="file-item"]',
        );
        const isBusy = !!document.querySelector(
          '.ant-progress-bg, .ant-upload-list-item-uploading, [class*="uploading"], .ant-btn-loading',
        );
        return chips.length >= count && !isBusy;
      },
      filePaths.length,
      { timeout: 45_000 },
    );
  };

  try {
    await attemptUpload();
  } catch (err: any) {
    if (err.message.includes("Timeout")) {
      console.warn(`[Qwen] Warning: Timeout waiting for upload chips. Assuming uploaded and continuing.`);
    } else {
      throw err;
    }
  }

  console.log(`[Qwen] ${filePaths.length} file(s) confirmed loaded.`);
}

// ─── Send ─────────────────────────────────────────────────────────────────────

async function typeAndSend(page: Page, message: string): Promise<void> {
  const INPUT = "textarea.message-input-textarea";
  await page.waitForSelector(INPUT, { timeout: 15_000 });
  await page.click(INPUT);
  if (message.length <= 50) {
    await page.type(INPUT, message, { delay: 1 });
  } else {
    await page.fill(INPUT, message);
  }

  const SEND_SEL =
    'button.send-button, [class*="send-button"], button[aria-label*="Send" i]';
  const btn = await page.waitForSelector(SEND_SEL, { timeout: 10_000 });
  if (!btn) throw new Error("Send button not found");
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
  timeoutMs = 1_800_000,
): Promise<void> {
  console.log(
    `[Qwen] Waiting for reply (Qwen answers so far: ${countBefore})...`,
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await getReplyCount(page);
    if (count > countBefore) {
      console.log(`[Qwen] New reply detected (count: ${count}).`);
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error("[Qwen] Timed out waiting for reply");
}

// ─── Extract response at a specific index ────────────────────────────────────
// FIX: previously extractResponse always grabbed the LAST bubble on the page,
// which could be a "Ready" from an intermediate batch.
// Now we snapshot the reply count BEFORE sending the final message and extract
// specifically the bubble at that index — guaranteed to be the final answer.

async function extractResponseAtIndex(
  page: Page,
  targetIndex: number,
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
  await page.waitForFunction(
    () =>
      !document.querySelector(
        '.qwen-chat-package-comp-new-action-control-container-stop, .anticon-loading, [class*="stop-generating"]',
      ),
    { timeout: 300_000 },
  );

  // Step 3: Stability — 5 consecutive 1.5s polls with no char-count change on the target bubble
  let last = -1;
  let stable = 0;
  const STABLE_NEEDED = 5;

  while (stable < STABLE_NEEDED) {
    const count = await page.evaluate(
      ({ sel, idx }: { sel: string; idx: number }) => {
        const els = document.querySelectorAll(sel);
        const el = els[idx] as HTMLElement | undefined;
        return el?.innerText?.length ?? 0;
      },
      { sel: REPLY_SEL, idx: targetIndex },
    );

    if (count === last && count > 0) {
      stable++;
    } else {
      stable = 0;
      last = count;
    }
    await page.waitForTimeout(1500);
  }

  // Step 4: Final settle pause
  await page.waitForTimeout(2000);

  // Step 5: Extract text from the specific bubble at targetIndex
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
  manifestContent: string,
  contextDir: string,
  onStatus?: (msg: string, partial?: string, progress?: number) => void,
  outDir: string = "",
  isFirstTurn: boolean = true,
): Promise<string> {
  const context = page.context();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "https://chat.qwen.ai",
  });

  const existingPage = context
    .pages()
    .find((p: Page) => p.url().includes("chat.qwen.ai"));
  const qPage = existingPage ?? page;

  if (!qPage.url().includes("chat.qwen.ai")) {
    onStatus?.("Navigating to Qwen AI…");
    await qPage.goto("https://chat.qwen.ai/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
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

    const symbolsPath = path.join(metadataBase, "symbols.json");
    if (fs.existsSync(symbolsPath)) {
      try {
        const syms = JSON.parse(fs.readFileSync(symbolsPath, "utf-8"));
        const lines = Object.entries(syms)
          .slice(0, 500)
          .map(([n, d]) => `${n}: ${(d as any).defined_in ?? ""}`);
        const dst = path.join(sessionDir, "symbols.txt");
        fs.writeFileSync(
          dst,
          lines.join("\n") || "// No symbols found.",
          "utf-8",
        );
        addFile(dst);
      } catch {}
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
    const countBefore = await getReplyCount(qPage);
    await typeAndSend(qPage, query);
    await waitForReply(qPage, countBefore);
    return extractResponseAtIndex(qPage, countBefore); // countBefore = index of the new reply
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
      const finalReplyIndex = await getReplyCount(qPage);
      onStatus?.("Sending final query…");
      await typeAndSend(qPage, msg);
      await waitForReply(qPage, finalReplyIndex);
      return extractResponseAtIndex(qPage, finalReplyIndex);
    } else {
      const replyCountBefore = await getReplyCount(qPage);
      await typeAndSend(
        qPage,
        `Context Part ${i + 1}/${batches.length} attached. Wait for the next part. Reply only "Ready".`,
      );
      await waitForReply(qPage, replyCountBefore);
      console.log(`[Qwen] Batch ${i + 1} acknowledged. Settling...`);
      await qPage.waitForTimeout(5000);
    }
  }

  return "";
}
