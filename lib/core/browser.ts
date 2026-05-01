import { chromium, BrowserContext } from "playwright";
import path from "path";
import os from "os";

const GLOBAL_CONTEXT_KEY = Symbol.for("repoorbit.playwright.context");
let sharedContext: BrowserContext | null =
  (global as any)[GLOBAL_CONTEXT_KEY] || null;

export async function getOrCreateContext(): Promise<BrowserContext> {
  if (sharedContext) {
    try {
      const pages = sharedContext.pages();
      if (pages.length >= 0) {
        // Just checking if context is alive
        return sharedContext;
      }
    } catch {
      sharedContext = null;
    }
  }

  const USER_DATA_DIR = path.join(os.homedir(), ".automation_browser_data");

  sharedContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: "/usr/bin/brave",
    headless: false,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  });

  (global as any)[GLOBAL_CONTEXT_KEY] = sharedContext;
  return sharedContext;
}
