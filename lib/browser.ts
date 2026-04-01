import { chromium, BrowserContext } from "playwright";
import path from "path";

const GLOBAL_CONTEXT_KEY = Symbol.for("repoorbit.playwright.context");
let sharedContext: BrowserContext | null = (global as any)[GLOBAL_CONTEXT_KEY] || null;

export async function getOrCreateContext(): Promise<BrowserContext> {
  if (sharedContext) {
    try {
      const pages = sharedContext.pages();
      if (pages.length > 0) {
        await pages[0].evaluate(() => 1);
        return sharedContext;
      }
    } catch {
      sharedContext = null;
    }
  }

  try {
    const browser = await chromium.connectOverCDP("http://localhost:9222");
    sharedContext = browser.contexts()[0];
    (global as any)[GLOBAL_CONTEXT_KEY] = sharedContext;
    return sharedContext;
  } catch (err: any) {
    const profilePath = path.join(process.cwd(), ".notebooklm-profile");
    sharedContext = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    (global as any)[GLOBAL_CONTEXT_KEY] = sharedContext;
    return sharedContext;
  }
}
