import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

export const OPENCODE_MODEL_ID = "nvidia/llama-3.3-nemotron-super-49b-v1";

let opencodeProcess: ChildProcess | null = null;
const OPENCODE_PATH = "opencode";

export async function ensureOpenCodeServer(port: number, directory: string) {
  if (opencodeProcess && !opencodeProcess.killed) return;

  console.log(`[AGENT] Clearing port ${port}...`);
  try {
    const { execSync } = require("child_process");
    execSync(`fuser -k ${port}/tcp || true`);
  } catch (e) {}

  console.log(`[AGENT] Booting OpenCode on port ${port}...`);
  opencodeProcess = spawn(OPENCODE_PATH, ["serve", "--port", String(port)], {
    cwd: directory,
    env: { ...process.env },
  });

  opencodeProcess.stdout?.on("data", (data) => process.stdout.write(`[opencode] ${data}`));
  opencodeProcess.stderr?.on("data", (data) => process.stderr.write(`[opencode-err] ${data}`));

  const start = Date.now();
  while (Date.now() - start < 30000) {
    try {
      // Use 127.0.0.1 to avoid IPv6/localhost resolution issues
      const res = await fetch(`http://127.0.0.1:${port}/session`, { signal: AbortSignal.timeout(1000) });
      if (res.ok || res.status === 404 || res.status === 405) {
        console.log(`[AGENT] OpenCode is ready on 127.0.0.1:${port}.`);
        return;
      }
    } catch (e) {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("OpenCode failed to start within 30 seconds.");
}

export async function runAutonomousAgent(port: number, directory: string, prompt: string): Promise<string> {
  const url = `http://127.0.0.1:${port}/session`;
  
  // 1. Create a session (with modelID specified at creation)
  console.log(`[AGENT] Creating session with model ${OPENCODE_MODEL_ID}...`);
  const sessionRes = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
      directory,
      modelID: OPENCODE_MODEL_ID 
    }),
    signal: AbortSignal.timeout(10000),
  });
  
  if (!sessionRes.ok) {
    const errText = await sessionRes.text();
    throw new Error(`Failed to create session (${sessionRes.status}): ${errText}`);
  }
  const { id: sessionId } = await sessionRes.json();

  // 2. Send the task
  console.log(`[AGENT] Task started in session ${sessionId}.`);
  const msgRes = await fetch(`${url}/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
      content: prompt,
      modelID: OPENCODE_MODEL_ID 
    }),
    signal: AbortSignal.timeout(1800000), 
  });

  if (!msgRes.ok) {
    const errText = await msgRes.text();
    throw new Error(`Agent message failed (${msgRes.status}): ${errText}`);
  }
  const data = await msgRes.json();
  
  const output = (data.parts || [])
    .map((p: any) => p.text || p.thought || p.content || "")
    .join("\n");

  return output || "Task completed.";
}
