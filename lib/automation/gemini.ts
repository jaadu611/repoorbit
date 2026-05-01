import { Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export async function askGemini(
  page: Page,
  query: string,
  filePaths: string[] = [],
  onStatus?: (msg: string, partial?: string, progress?: number) => void,
): Promise<string> {
  const url = page.url();
  if (!url.includes("gemini.google.com")) {
    onStatus?.("Navigating to Gemini...");
    await page.goto("https://gemini.google.com/app", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(3000);
  }

  // 1. Upload Files if any
  if (filePaths.length > 0) {
    onStatus?.(`Uploading ${filePaths.length} file(s) to Gemini...`);
    await uploadFilesToGemini(page, filePaths);
  }

  // 2. Send Query
  onStatus?.("Sending query to Gemini...");
  await typeAndSubmitGemini(page, query);

  onStatus?.("Waiting for Gemini to respond...");
  return await waitForGeminiCompletion(page, onStatus);
}

async function uploadFilesToGemini(page: Page, filePaths: string[]): Promise<void> {
  for (const filePath of filePaths) {
    // Click Plus icon
    const plusBtn = await page.waitForSelector('button[aria-label="Open upload file menu"]', { timeout: 10000 });
    await plusBtn.click();
    await page.waitForTimeout(500);

    // Click 'Upload files'
    const uploadBtn = await page.waitForSelector('button[aria-label="Upload files. Documents, data, code files"]', { timeout: 5000 });
    
    // Playwright file input trigger
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      uploadBtn.click(),
    ]);
    await fileChooser.setFiles(filePath);
    
    // Wait for upload progress
    await page.waitForTimeout(2000);
  }
}

async function typeAndSubmitGemini(page: Page, message: string): Promise<void> {
  const inputSelector = 'div[aria-label="Enter a prompt for Gemini"], .ql-editor.textarea';
  await page.waitForSelector(inputSelector, { timeout: 30000 });
  
  await page.click(inputSelector);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  
  // Use fill if it works for contenteditable, or evaluate
  await page.evaluate(({ selector, msg }) => {
    const el = document.querySelector(selector) as HTMLElement;
    if (el) {
      el.innerText = msg;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, { selector: inputSelector, msg: message });

  await page.waitForTimeout(500);
  
  const sendBtn = await page.waitForSelector('button[aria-label="Send message"]', { timeout: 10000 });
  await sendBtn.click();
}

async function waitForGeminiCompletion(
  page: Page,
  onStatus?: (msg: string, partial?: string, progress?: number) => void,
  timeoutMs = 300_000,
): Promise<string> {
  const startTime = Date.now();
  let lastSeenText = "";
  let stableCount = 0;
  const STABLE_POLLS_NEEDED = 5;

  await page.waitForTimeout(3000); 

  while (Date.now() - startTime < timeoutMs) {
    const candidate = await page.evaluate(() => {
      // Gemini messages are usually in 'message-content' model
      const messages = Array.from(document.querySelectorAll('message-content:not([class*="user"]), .model-response-text'));
      if (messages.length === 0) return null;
      
      const lastMessage = messages[messages.length - 1] as HTMLElement;
      
      // Stop button check
      const stopBtn = document.querySelector('button[aria-label="Stop response"]');
      const isGenerating = !!stopBtn || !!document.querySelector('.generating, .loading-indicator');
      
      return {
        text: lastMessage.innerText.trim(),
        isGenerating
      };
    });

    if (candidate && candidate.text.length > 0) {
      if (candidate.isGenerating) {
        onStatus?.("Gemini generating...", candidate.text.substring(0, 100) + "...");
        stableCount = 0;
      } else {
        if (candidate.text === lastSeenText) {
          stableCount++;
          if (stableCount >= STABLE_POLLS_NEEDED) return candidate.text;
        } else {
          stableCount = 0;
        }
      }
      lastSeenText = candidate.text;
    }
    await page.waitForTimeout(1000);
  }
  return lastSeenText;
}
