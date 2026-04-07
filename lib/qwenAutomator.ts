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

  // Wait until all file chips appear and none are still uploading
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
    { timeout: 40_000 },
  );

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

// ─── Reply detection — counts only Qwen answer bubbles ───────────────────────

// Matches the exact classes Qwen puts on its answer elements
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
  timeoutMs = 120_000,
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

// ─── Extract final response via clipboard ─────────────────────────────────────

const SENTINEL = "__QWEN_WAITING__";

async function extractResponse(page: Page): Promise<string> {
  // Wait until generation stops (stop button gone)
  await page.waitForFunction(
    () =>
      !document.querySelector(
        '.qwen-chat-package-comp-new-action-control-container-stop, .anticon-loading, [class*="stop-generating"]',
      ),
    { timeout: 300_000 },
  );

  // Stability: 2 consecutive seconds with no char-count change in the last reply
  let last = -1,
    stable = 0;
  while (stable < 2) {
    const count = await page.evaluate((sel) => {
      const els = document.querySelectorAll(sel);
      return (
        (els[els.length - 1] as HTMLElement | undefined)?.innerText?.length ?? 0
      );
    }, REPLY_SEL);
    if (count === last) stable++;
    else {
      stable = 0;
      last = count;
    }
    await page.waitForTimeout(1000);
  }

  // Extract final text via robust DOM selection
  return page.evaluate(() => {
    const selectors = [
      '[data-message-author-role="assistant"]',
      '.markdown-body:not([class*="user"])',
      '.response-message-content',
      '[class*="message-content"]:not([class*="user"])',
      '[class*="assistant"]'
    ];

    let lastBubble: HTMLElement | null = null;
    for (const sel of selectors) {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(sel));
      if (nodes.length > 0) {
        lastBubble = nodes[nodes.length - 1];
        break;
      }
    }

    if (!lastBubble) return "";

    const clone = lastBubble.cloneNode(true) as HTMLElement;
    const ignoreEls = clone.querySelectorAll('button, [role="button"], [class*="copy"], [class*="download"], header, .md-code-block-header');
    ignoreEls.forEach(el => el.remove());

    return clone.innerText?.trim() ?? "";
  });
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

    const rootManifest = path.join(
      metadataBase,
      "00_Root_Manifest_Annotated.txt",
    );
    if (fs.existsSync(rootManifest)) {
      const dst = path.join(sessionDir, "00_Root_Manifest_Annotated.txt");
      fs.writeFileSync(dst, fs.readFileSync(rootManifest, "utf-8"), "utf-8");
      addFile(dst);
    }

    const turnManifest = path.join(sessionDir, "manifest.txt");
    fs.writeFileSync(turnManifest, manifestContent, "utf-8");
    addFile(turnManifest);

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
    return extractResponse(qPage);
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
      const countBefore = await getReplyCount(qPage);
      onStatus?.("Sending final query…");
      await typeAndSend(qPage, msg);
      await waitForReply(qPage, countBefore);
      return extractResponse(qPage);
    } else {
      // Snapshot reply count BEFORE sending — .phase-answer only matches Qwen's bubbles, not ours
      const replyCountBefore = await getReplyCount(qPage);
      await typeAndSend(
        qPage,
        `Context Part ${i + 1}/${batches.length} attached. Wait for the next part. Reply only "Ready".`,
      );
      await waitForReply(qPage, replyCountBefore);
    }
  }

  return "";
}
