import * as fs from "fs";
import * as path from "path";
import { createSession, sendToPort } from "../lib/automation/opencode";
import { 
  getGemmaDiskOperatorPrompt, 
  getTestGenerationPrompt, 
  getGemmaTestRunnerPrompt, 
  getGeminiDiskVerifierPrompt 
} from "../lib/prompts";

/**
 * MANUAL ARCHITECT TESTER
 * Paste your hardcoded Architect Output below and run with:
 * npx tsx scratch/run_manual_architect.ts
 */

const REPO_PATH = "/home/jaadu/valibot"; // Change this if needed
const ARCHITECT_OUTPUT = `
### EXECUTIVE SUMMARY
This fix addresses the issue in src/index.ts by updating the version string.

### INSTRUCTIONS
In src/index.ts, replace the entire file with:
export const version = "1.2.3-final-fix";
export const author = "Architect";
`;

async function runTest() {
  console.log("🛠️ RUNNING MANUAL ARCHITECT TEST");
  console.log(`📍 Repo: ${REPO_PATH}`);

  const architectFile = path.join(REPO_PATH, "final_architect_output.txt");
  
  // Only write if the file doesn't exist OR if you changed the dummy content
  const isDummy = ARCHITECT_OUTPUT.includes("1.2.3-final-fix");
  if (!fs.existsSync(architectFile) || !isDummy) {
    fs.writeFileSync(architectFile, ARCHITECT_OUTPUT.trim(), "utf-8");
    console.log(`✅ Updated Architect Output at: ${architectFile}`);
  } else {
    console.log(`ℹ️ Using EXISTING Architect Output at: ${architectFile}`);
  }

  const finalContent = fs.readFileSync(architectFile, "utf-8");

  try {
    const start = Date.now();
    // 1. Apply Changes
    console.log("\n⏳ [Phase 2] Gemma applying changes...");
    const gemmaSid = await createSession(3001, REPO_PATH, "google/gemma-4-31b-it");
    const gemmaPrompt = getGemmaDiskOperatorPrompt({ architectFilePath: architectFile });
    const gemmaResult = await sendToPort(3001, gemmaSid, gemmaPrompt);
    console.log(`✅ Gemma applied changes in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    console.log("📄 Gemma Output Snippet:\n", gemmaResult.slice(0, 500) || "(EMPTY)");

    // 2. Generate & Run Tests
    const tGenStart = Date.now();
    console.log("\n⏳ [Phase 2.5] Generating tests...");
    const testGenPrompt = getTestGenerationPrompt({ architectOutput: finalContent });
    const testRes = await createSession(3002, REPO_PATH, "google/gemini-3-flash-preview")
      .then(sid => sendToPort(3002, sid, testGenPrompt));
    
    const testsFile = path.join(REPO_PATH, "generated_tests.txt");
    const logsFile = path.join(REPO_PATH, "tests_logs.txt");
    fs.writeFileSync(testsFile, testRes, "utf-8");
    
    console.log("⏳ Gemma running tests...");
    const gemmaTestSid = await createSession(3001, REPO_PATH, "google/gemma-4-31b-it");
    const gemmaTestPrompt = getGemmaTestRunnerPrompt({ testsFilePath: testsFile });
    const gemmaTestResult = await sendToPort(3001, gemmaTestSid, gemmaTestPrompt);
    fs.writeFileSync(logsFile, gemmaTestResult, "utf-8");
    console.log(`✅ Testing completed in ${((Date.now() - tGenStart) / 1000).toFixed(1)}s`);

    // 3. Verify
    const vStart = Date.now();
    console.log("\n⏳ [Phase 3] Gemini Flash verifying...");
    const combinedGemma = `[OPERATOR]\n${gemmaResult}\n\n[TESTS]\n${gemmaTestResult}`;
    const flashPrompt = getGeminiDiskVerifierPrompt({ 
      gemmaOutput: combinedGemma, 
      architectFilePath: architectFile 
    });
    const flashSid = await createSession(3002, REPO_PATH, "google/gemini-3-flash-preview");
    const flashResult = await sendToPort(3002, flashSid, flashPrompt);
    console.log(`✅ Flash verified in ${((Date.now() - vStart) / 1000).toFixed(1)}s`);
    console.log("📄 Flash Final Verdict:\n", flashResult);

    console.log(`\n✨ TOTAL TEST TIME: ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error("❌ TEST FAILED:", e);
  }
}

runTest();
