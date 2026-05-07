import fs from "fs";
import path from "path";
import { ensureOpenCodeServer, createSession, sendToPort } from "@/lib/automation/opencode";
import { getGemmaDiskOperatorPrompt } from "@/lib/prompts";

export async function runSurgeryPhase2(
  owner: string,
  repo: string,
  repoWorkDir: string,
  finalAnswer: string,
  outDir: string,
  onStatus: (msg: string) => void,
  questionsUsed: Map<string, number>,
): Promise<string> {
  onStatus("Initiating Surgical Phase 2 — Change Application...");

  // 1. Write the Architect's plan to a file for the disk model to read
  const architectFilePath = path.join(
    repoWorkDir,
    "final_architect_output.txt",
  );
  fs.writeFileSync(architectFilePath, finalAnswer, "utf-8");

  // 2. Ensure OpenCode server is running in the CORRECT directory
  onStatus(`Operator — Restarting OpenCode server in ${repoWorkDir}...`);
  await ensureOpenCodeServer(3001, repoWorkDir);

  // 3. Start the disk model session
  onStatus("Operator is initializing workspace session...");
  // Using the full requested google/gemma-4-31b-it model ID
  const gemmaSessionId = await createSession(
    3001,
    repoWorkDir,
    "google/gemma-4-31b-it",
  );

  // 4. Prepare the environment info if available
  const envInfoPath = path.join(repoWorkDir, "env_info.json");
  const envInfo = fs.existsSync(envInfoPath)
    ? fs.readFileSync(envInfoPath, "utf-8")
    : undefined;

  // 5. Instruct the disk model to apply changes
  const gemmaPrompt = getGemmaDiskOperatorPrompt({
    architectFilePath: "final_architect_output.txt",
    questionsLeft: 0,
    envInfo,
  });

  onStatus(`Operator — Applying changes to disk...`);
  
  // Start a background log poller to show progress on frontend
  const { getOpenCodeLogs } = await import("@/lib/automation/opencode");
  const logInterval = setInterval(() => {
    const logs = getOpenCodeLogs();
    if (logs) {
      // Use the last non-empty line of logs as the status text if it's short
      const lines = logs.trim().split("\n");
      const lastLine = lines[lines.length - 1];
      if (lastLine && lastLine.length < 100) {
        onStatus(`Operator — ${lastLine}`, undefined, undefined, undefined, undefined, logs);
      } else {
        onStatus(`Operator — Applying changes...`, undefined, undefined, undefined, undefined, logs);
      }
    }
  }, 2000);

  let gemmaResult = "";
  try {
    gemmaResult = await sendToPort(3001, gemmaSessionId, gemmaPrompt);
  } finally {
    clearInterval(logInterval);
  }

  // Log the model's actual response for debugging
  console.log("=== DISK MODEL RESPONSE ===");
  console.log(gemmaResult);
  console.log("===========================");

  if (!gemmaResult || gemmaResult.length < 5) {
    onStatus("Warning: Disk model returned an empty or very short response.");
  }

  onStatus("Changes applied. Surgical Phase 2 complete.");
  return "DONE: Final architecture application pass finished. Check the console for model logs.";
}
