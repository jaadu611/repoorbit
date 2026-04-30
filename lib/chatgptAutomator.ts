import { Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Unified ChatGPT automator.
 *
 * When `contextDir` is provided, it uploads all staged files before sending
 * the query (used in the code investigation orchestration loop).
 * When omitted, it sends the prompt directly (used for generic questions).
 */
export async function automateChatGPT(
  page: Page,
  query: string,
  onStatus?: (msg: string, partial?: string, progress?: number) => void,
  contextDir?: string,
  outDir: string = "",
  isFirstTurn: boolean = true,
): Promise<string> {
  const url = page.url();
  if (!url.includes("chatgpt.com")) {
    onStatus?.("Navigating to ChatGPT...");
    await page.goto("https://chatgpt.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(3000);
  }

  // ── Stage & upload files (only if contextDir provided) ───────────────────
  if (contextDir && fs.existsSync(contextDir)) {
    const sessionDir = path.join(os.tmpdir(), `chatgpt_upload_${Date.now()}`);
    fs.mkdirSync(sessionDir, { recursive: true });
    const allTmpPaths: string[] = [];

    for (const f of fs.readdirSync(contextDir)) {
      const src = path.join(contextDir, f);
      const dst = path.join(sessionDir, f);
      fs.copyFileSync(src, dst);
      allTmpPaths.push(dst);
    }

    if (isFirstTurn && outDir && fs.existsSync(outDir)) {
      for (const name of ["00_Root_Manifest.txt"]) {
        const p = path.join(outDir, name);
        if (fs.existsSync(p)) {
          const dst = path.join(sessionDir, name);
          if (allTmpPaths.some((x) => path.basename(x) === name)) continue;
          const content = fs.readFileSync(p, "utf-8");
          fs.writeFileSync(dst, content, "utf-8");
          allTmpPaths.push(dst);
        }
      }
    }

    if (allTmpPaths.length > 0) {
      onStatus?.(`Uploading ${allTmpPaths.length} file(s) to ChatGPT...`);
      try {
        let fileInput = await page.$('input[type="file"]');
        if (!fileInput) {
          const attachBtn = await page
            .$(
              '[data-testid="composer-attach-button"], button[aria-label*="Attach" i], button[aria-label*="Upload" i]',
            )
            .catch(() => null);
          if (attachBtn) {
            await attachBtn.click();
            await page.waitForTimeout(800);
            fileInput = await page.$('input[type="file"]');
          }
        }
        if (!fileInput) {
          fileInput = (await page.evaluateHandle(() => {
            const el = document.querySelector(
              'input[type="file"]',
            ) as HTMLInputElement | null;
            if (el) {
              el.style.display = "block";
              el.style.opacity = "1";
              el.style.position = "fixed";
              el.style.top = "0";
              el.style.zIndex = "99999";
            }
            return el ?? null;
          })) as any;
        }
        if (fileInput) {
          await fileInput.setInputFiles(allTmpPaths);
          await page.waitForTimeout(4000);
        } else {
          console.warn("[ChatGPT] Could not find file input — skipping upload.");
        }
      } catch (err: any) {
        console.warn("[ChatGPT] File upload error:", err.message);
      }
    }
  }

  // ── Send query ────────────────────────────────────────────────────────────
  onStatus?.("Sending query to ChatGPT...");
  const inputSelector = "#prompt-textarea";
  const inputHandle = await page.waitForSelector(inputSelector, {
    timeout: 30_000,
  });
  if (!inputHandle) throw new Error("Could not find ChatGPT input box.");
  await inputHandle.click();
  await page.keyboard.insertText(query);
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");

  // ── Poll for stable response ──────────────────────────────────────────────
  onStatus?.("Waiting for ChatGPT to respond...");
  const startTime = Date.now();
  let lastText = "";
  let stableCount = 0;
  const STABLE_NEEDED = 4;

  while (Date.now() - startTime < 300_000) {
    const result = await page.evaluate(() => {
      const msgs = document.querySelectorAll(
        '[data-message-author-role="assistant"]',
      );
      if (!msgs.length) return null;
      const last = msgs[msgs.length - 1] as HTMLElement;
      const isGenerating = !!document.querySelector(
        'button[aria-label="Stop generating"]',
      );
      return { text: last.innerText?.trim() ?? "", isGenerating };
    });

    if (result && result.text.length > 0) {
      const preview = result.text.substring(0, 120).replace(/\n/g, " ");
      onStatus?.("ChatGPT generating...", preview + "...");
      if (!result.isGenerating && result.text === lastText) {
        stableCount++;
        if (stableCount >= STABLE_NEEDED) {
          onStatus?.("ChatGPT response complete.");
          // Best-effort clipboard copy
          try {
            await page.bringToFront();
            await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
            const copied = await page.evaluate(() => {
              const msgs = Array.from(
                document.querySelectorAll('[data-message-author-role="assistant"]'),
              );
              if (!msgs.length) return false;
              const last = msgs[msgs.length - 1];
              function deep(sel: string, root: Element | Document = document): Element[] {
                let els = Array.from(root.querySelectorAll(sel));
                root.querySelectorAll("*").forEach((el) => {
                  if ((el as any).shadowRoot)
                    els = els.concat(deep(sel, (el as any).shadowRoot));
                });
                return els;
              }
              const btns = deep('button[aria-label*="Copy"]', last) as HTMLElement[];
              if (btns.length) { btns[btns.length - 1].click(); return true; }
              return false;
            });
            if (copied) {
              await page.waitForTimeout(600);
              const clip = await page.evaluate(async () => {
                try { return await navigator.clipboard.readText(); } catch { return ""; }
              });
              if (clip && clip.length > 50) return clip.trim();
            }
          } catch {}
          return result.text;
        }
      } else {
        stableCount = 0;
        lastText = result.text;
      }
    }
    await page.waitForTimeout(2000);
  }

  if (lastText.length > 0) {
    onStatus?.("ChatGPT timed out — using partial response.");
    return lastText;
  }
  throw new Error("ChatGPT analysis timeout after 5 minutes with no response.");
}

/** Convenience alias used by the coding orchestration loop */
export const askChatGPTCoder = (
  page: Page,
  query: string,
  manifestContent: string,
  contextDir: string,
  onStatus?: (msg: string, partial?: string, progress?: number) => void,
  outDir: string = "",
  isFirstTurn: boolean = true,
) => automateChatGPT(page, query, onStatus, contextDir, outDir, isFirstTurn);
