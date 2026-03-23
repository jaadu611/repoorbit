const { chromium } = require('playwright');

async function run() {
  console.log("Connecting to Brave via CDP (9222)...");
  let browser;
  try {
    browser = await chromium.connectOverCDP("http://localhost:9222");
    const context = browser.contexts()[0];
    const pages = context.pages();
    
    // Find the RepoOrbit page
    const page = pages.find(p => p.url().includes("localhost:3000") || p.url().includes("0.0.0.0:3000"));
    
    if (!page) {
      console.error("Could not find the RepoOrbit page in your Brave session. Please make sure http://localhost:3000 is open.");
      await browser.close();
      return;
    }

    console.log("Found RepoOrbit page. Bringing to front...");
    await page.bringToFront();

    // Look for the chat input. Standard pattern for these apps is a textarea or an input with 'Ask' or 'Query'.
    const chatInput = page.locator('textarea, input[placeholder*="Ask"], input[placeholder*="query"]').first();
    
    console.log("Thinking... Typing query: 'Tell me about this repo please'");
    await chatInput.waitFor({ state: "visible", timeout: 10000 });
    await chatInput.click();
    await chatInput.fill("Tell me about this repo please");
    
    console.log("Sending query...");
    await page.keyboard.press("Enter");
    
    console.log("Successfully sent query! Watch your terminal logs for the expert planning and NotebookLM upload.");
    
    await browser.close();
  } catch (err) {
    console.error("Failed to connect or interact:", err.message);
    if (browser) await browser.close();
  }
}

run();
