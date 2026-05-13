import fs from "fs";
import path from "path";
import { parseJsonFromText } from "./utils";
import { askNvidia, NVIDIA_MODEL } from "@/lib/automation/llm";
import { exec as execAsyncRaw } from "child_process";
import { promisify } from "util";
const exec = promisify(execAsyncRaw);
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/**
 * Orchestrates a single model's thought process, including multi-turn context fetching.
 */
export async function runSingleModelTurn(
  model: NVIDIA_MODEL,
  promptGenerator: (attempt: number) => string,
  investDir: string,
  contextDir: string,
  owner: string,
  repo: string,
  defaultBranch: string,
  rootManifestContent: string,
  onStatus: (msg: string) => void,
  latestResponsePath: string,
  displayName: string,
  questionsUsed: Map<string, number>,
  updateAgent?: (agent: any) => void,
  readOnly: boolean = true,
  existingMessages: any[] = []
): Promise<{ answer: string; messages: any[] }> {
  let done = false;
  let attempt = 0;
  let currentPrompt = promptGenerator(0);
  
  const messages: any[] = existingMessages.length > 0 ? [...existingMessages] : [
    { role: "user", content: currentPrompt },
    { role: "user", content: `### REPOSITORY MANIFEST\nBelow is the complete file list of the repository. Use this to locate files before running commands.\n\n${rootManifestContent}` }
  ];

  // Inject latest context as a "Correction/Update" if we have history
  if (latestResponsePath && fs.existsSync(latestResponsePath)) {
    const latestContent = fs.readFileSync(latestResponsePath, "utf-8");
    const prefix = existingMessages.length > 0 ? "### UPDATE: LATEST REVISED PLAN\n" : "### PEER CONTEXT (IMPORTANT)\n";
    messages.push({
      role: "user",
      content: `${prefix}Here is the latest plan/response from the previous pass or peer agents. Use this to maintain consistency:\n\n${latestContent}`,
    });
  }

  let finalContent = "";
  const MAX_ATTEMPTS = 100;

  while (!done && attempt < MAX_ATTEMPTS) {
    if (!fs.existsSync(investDir)) fs.mkdirSync(investDir, { recursive: true });

    if (attempt === MAX_ATTEMPTS - 1) {
      messages.push({
        role: "user",
        content: "### FINAL ATTEMPT\nWrap up your analysis and output the FINAL CODE BLOCKS now. Do not run more commands or fetch more context."
      });
    }

    if (updateAgent) {
      updateAgent({
        id: displayName,
        name: displayName,
        model: model,
        status: "thinking",
        lastMsg: `Thinking (Turn ${attempt})...`
      });
    }

    const messagesToModel: any[] = [
      { 
        role: "system", 
        content: "You are a technical pipeline agent. NO PROSE. NO SMALL TALK. Respond ONLY with JSON protocol or CODE blocks.\n\n" +
                 (readOnly 
                   ? "### MODE: READ-ONLY\nYou are in the investigation phase. You CANNOT modify files. Use 'cat' and 'grep' to gather data. Any attempt to write will be blocked.\n\n" 
                   : "### MODE: WRITE (ACTIVE SURGERY)\nYou are the Chief Surgeon. You MUST apply changes to the files. Use 'cat > file << EOF' to write code. You have full authority to modify the repo.\n\n") +
                 "### PERSISTENCE NOTE\n" +
                 "Your previous thoughts and peer feedback are saved locally in the 'temp/' folder for you to reference:\n" +
                 "- `temp/combined_response.txt`: The latest synthesized code and plan from the team.\n" +
                 "- `temp/combined_reviews.txt`: The latest critical feedback from all 3 reviewers.\n" +
                 "You can 'cat' these files to maintain consistency and avoid repeating mistakes.\n\n" +
                 "### SPEED OPTIMIZATION: BATCHED EXPLORATION\n" +
                 "The server has a high cold-start latency. TO SAVE TIME, YOU MUST BATCH YOUR COMMANDS.\n" +
                 "If you need to see multiple files or run multiple greps, output ALL of them in your FIRST response.\n" +
                 "Do not fetch files one by one. Maximize your 5-command-per-turn limit immediately."
      },
      ...messages
    ];

    // --- THROTTLING LOGIC ---
    // 5s wait before every call + 20s every 6 messages
    await sleep(5000);
    if (attempt > 0 && attempt % 6 === 0) {
      onStatus(`Throttling: 20s cooldown (6-message limit)...`);
      await sleep(20000);
    }

    const rawResponse = await askNvidia(
      model,
      messagesToModel,
      onStatus,
      `[${displayName}]`
    );

    // Save turn output for debugging
    const turnPath = path.join(investDir, `subturn_${attempt}_raw.txt`);
    fs.writeFileSync(turnPath, rawResponse, "utf-8");

    let statusBlocks = parseJsonFromText(rawResponse, true);

    // --- HEURISTIC FALLBACK (For Lazy Models) ---
    if (statusBlocks.length === 0) {
      // 1. Try to find raw bash blocks
      const bashBlocks = rawResponse.match(/```bash[\s\S]*?```/g);
      if (bashBlocks) {
        bashBlocks.forEach(block => {
          const content = block.replace(/^```bash\s*/, "").replace(/```$/, "").trim();
          if (content) statusBlocks.push({ status: "RUN_COMMAND", command: content });
        });
      }
      // 2. Try to find custom "commands" JSON (Kimi style)
      const jsonBlocks = rawResponse.match(/```json\n([\s\S]*?)```/g);
      if (jsonBlocks) {
        jsonBlocks.forEach(block => {
          try {
            const content = block.replace(/```json\n/, "").replace(/```/, "").trim();
            const parsed = JSON.parse(content);
            if (parsed.commands && Array.isArray(parsed.commands)) {
              parsed.commands.forEach((cmd: any) => {
                const cmdStr = typeof cmd === "string" ? cmd : JSON.stringify(cmd);
                statusBlocks.push({ status: "RUN_COMMAND", command: cmdStr });
              });
            }
          } catch(e) {}
        });
      }
    }

    // Limit to first 5 commands to prevent context explosion
    const limitedBlocks = statusBlocks.slice(0, 5);

    if (limitedBlocks.length > 0) {
      let contextAddition = "### ADDITIONAL CONTEXT FETCHED\n\n";
      let hasUpdates = false;

      for (const block of limitedBlocks) {
        if (block.status === "NEED_MORE_CONTEXT") {
          const missingFiles = block.missing_files || [];
          for (const file of missingFiles) {
            const filePath = file.path;
            const fullPath = path.join(contextDir, filePath);
            if (fs.existsSync(fullPath)) {
              const stat = fs.statSync(fullPath);
              if (stat.isDirectory()) {
                const entries = fs.readdirSync(fullPath);
                contextAddition += `// --- DIRECTORY: ${filePath} ---\n${entries.join("\n")}\n\n`;
              } else {
                let content = fs.readFileSync(fullPath, "utf-8");
                if (file.line_range && Array.isArray(file.line_range) && file.line_range.length === 2) {
                  const [start, end] = file.line_range;
                  const lines = content.split("\n");
                  content = lines.slice(Math.max(0, start - 1), end).join("\n");
                  contextAddition += `// --- FILE: ${filePath} (Lines ${start}-${end}) ---\n${content}\n\n`;
                } else {
                  contextAddition += `// --- FILE: ${filePath} ---\n${content}\n\n`;
                }
              }
            } else {
              contextAddition += `// --- FILE NOT FOUND: ${filePath} ---\n\n`;
            }
          }
          hasUpdates = true;
        } else if (block.status === "RUN_COMMAND") {
          const command = block.command;
          
          // --- SECURITY FIREWALL: PREVENT MODIFICATIONS (Phase 1 Only) ---
          const isSafe = (cmd: any) => {
            if (!readOnly) return true; // Allow everything in Phase 2
            
            const cmdStr = String(cmd || "");
            // Allow standard error redirection 2>/dev/null
            const cleaned = cmdStr.replace(/2>\/dev\/null/g, "");
            const dangerous = [">", ">>", "sed -i", "rm ", "mv ", "cp ", "chmod", "chown", "git ", "mkdir", "truncate", "patch"];
            return !dangerous.some(d => cleaned.includes(d));
          };

          if (!isSafe(command)) {
            console.log(`[ORCHESTRATOR] ${displayName} blocked dangerous command: ${command}`);
            contextAddition += `### COMMAND BLOCKED\nERROR: Command contains forbidden modification tokens. YOU ARE IN A READ-ONLY ENVIRONMENT.\n\n`;
            hasUpdates = true;
            continue;
          }

          console.log(`[ORCHESTRATOR] ${displayName} executing: ${command}`);
          try {
            const { stdout, stderr } = await exec(command, { 
              cwd: contextDir,
              timeout: 15000,
              maxBuffer: 1024 * 1024
            });
            const result = stdout + (stderr ? `\nERR: ${stderr}` : "");
            contextAddition += `### COMMAND: ${command}\n${result}\n\n`;
          } catch (e: any) {
            contextAddition += `### COMMAND: ${command}\nERROR: ${e.message}\n\n`;
          }
          hasUpdates = true;
        }
      }

      if (hasUpdates) {
        messages.push({ role: "assistant", content: rawResponse });
        messages.push({ role: "user", content: contextAddition + "Continue." });
        
        // --- CONTEXT HYGIENE: Capping total character count to prevent 1M token explosion ---
        // (Approx 4 chars per token, capping at ~150k tokens = 600k chars)
        let totalChars = messages.reduce((acc, m) => acc + (m.content?.length || 0), 0);
        while (totalChars > 600000 && messages.length > 3) {
          // Keep the prompt (index 0) and manifest (index 1), remove the oldest turn results
          const removed = messages.splice(2, 1)[0]; 
          totalChars -= (removed.content?.length || 0);
        }

        if (updateAgent) {
          updateAgent({
            id: displayName,
            name: displayName,
            model: model,
            status: "fetching",
            lastMsg: `Processed ${statusBlocks.length} actions.`
          });
        }
        attempt++;
        continue; // Next turn
      }
    }

    // If we reach here and not done, it means the model gave a final answer or no protocol
    console.log(`[ORCHESTRATOR] ${displayName} (${model}) - Received Final Answer. Done.`);
    finalContent = rawResponse;
    done = true;
    if (updateAgent) {
      updateAgent({
        id: displayName,
        name: displayName,
        model: model,
        status: "done",
        lastMsg: "Draft complete."
      });
    }
  }

  return { answer: finalContent, messages };
}
