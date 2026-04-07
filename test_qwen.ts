import { chromium } from "playwright";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

(async () => {
  const originalProfile = path.join(os.homedir(), ".qwen_playwright_profile");
  const tempProfile = path.join(os.tmpdir(), "temp_qwen_profile_" + Date.now());
  
  // Copy directory structure recursively
  fs.cpSync(originalProfile, tempProfile, { recursive: true });

  const context = await chromium.launchPersistentContext(tempProfile, { headless: true });
  const page = await context.newPage();
  await page.goto("https://chat.qwen.ai/", { timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.fill("textarea", "hello");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(7000);
  const bubbles = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[class*="message-content"], [class*="message-item"], [class*="bubble"]'))
      .map(el => ({ tag: el.tagName, className: el.className, text: (el as HTMLElement).innerText.substring(0, 50).replace(/\n/g, ' ') }));
  });
  console.log(JSON.stringify(bubbles, null, 2));
  await context.close();
})();
