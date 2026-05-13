import path from "path";
import fs from "fs";
import {
  ensureOpenCodeServer,
  createSession,
  sendToOpenCode,
  getOpenCodeLogs,
  writeOpencodeConfig,
  OPENCODE_MODEL_ID,
} from "@/lib/automation/opencode";
import { getSurgeonPrompt } from "@/lib/prompts";

const OPENCODE_PORT = 3001;

export async function runSurgeryPhase2(
  owner: string,
  repo: string,
  repoWorkDir: string,
  finalAnswer: string,
  outDir: string,
  onStatus: (msg: string) => void,
  questionsUsed: Map<string, number>,
  updateAgent: (agent: any) => void,
): Promise<string> {
  onStatus("Chief Surgeon (OpenCode + Nemotron) preparing workspace...");

  // 1. Write the plan to disk so the surgeon can reference it via 'cat'
  const planFilePath = path.join(repoWorkDir, "REPOORBIT_PLAN.md");
  fs.writeFileSync(planFilePath, finalAnswer, "utf-8");
  console.log(`[SURGERY] Plan written to ${planFilePath}`);

  // 2. Inject NVIDIA provider config into the repo directory
  writeOpencodeConfig(repoWorkDir);

  // 3. Boot OpenCode server pointed at the real sandbox
  onStatus(`Operator — Starting OpenCode server on port ${OPENCODE_PORT}...`);
  await ensureOpenCodeServer(OPENCODE_PORT, repoWorkDir);

  // 4. Create a fresh session (model is set via opencode.json)
  onStatus("Operator — Creating OpenCode session...");
  const sessionId = await createSession(OPENCODE_PORT, repoWorkDir);
  console.log(`[SURGERY] Session created: ${sessionId}`);

  // 5. Build the surgeon prompt
  const surgeonPrompt = getSurgeonPrompt({ surgicalPlan: finalAnswer });

  // 6. Stream logs to UI while OpenCode works
  const logInterval = setInterval(() => {
    const logs = getOpenCodeLogs();
    if (logs) {
      const lines = logs.trim().split("\n");
      const lastLine = lines[lines.length - 1];
      const msg = lastLine && lastLine.length < 120
        ? `Operator — ${lastLine}`
        : "Operator — Applying changes...";
      onStatus(msg);
    }
  }, 2000);

  updateAgent({ id: "surgeon", name: "OpenCode Surgeon", model: OPENCODE_MODEL_ID, status: "thinking", lastMsg: "Applying plan to disk..." });

  let result = "";
  try {
    onStatus("Operator — OpenCode is applying changes to the repo...");
    result = await sendToOpenCode(OPENCODE_PORT, sessionId, surgeonPrompt);
  } finally {
    clearInterval(logInterval);
  }

  console.log("[SURGERY] OpenCode response:\n", result);
  updateAgent({ id: "surgeon", name: "OpenCode Surgeon", model: OPENCODE_MODEL_ID, status: "done", lastMsg: "Changes applied." });
  onStatus("Surgery complete. OpenCode has applied all changes.");

  return result || "DONE: OpenCode surgery phase completed.";
}
