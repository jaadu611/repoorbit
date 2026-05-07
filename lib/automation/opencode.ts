import http from "http";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let opencodeProcess: ChildProcess | null = null;
let opencodeLogs: string = "";
const OPENCODE_PATH = "/home/jaadu/.npm-global/bin/opencode";

/**
 * Ensures the OpenCode server is running on the specified port.
 * Aggressively kills existing processes on the port to ensure directory switch.
 */
export async function ensureOpenCodeServer(
  port: number,
  directory: string,
): Promise<void> {
  const { execSync } = await import("child_process");

  try {
    console.log(`[ORCHESTRATOR] Killing existing OpenCode server on port ${port}...`);
    execSync(`fuser -k ${port}/tcp`, { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 2000));
  } catch (e) {
    // Ignore if nothing was running
  }

  // Always regenerate the config to ensure it's valid
  writeOpencodeConfig(directory);

  console.log(`[ORCHESTRATOR] Starting OpenCode server in: ${directory}`);
  opencodeLogs = ""; // Reset logs
  // Use detached and unref but pipe stdout to capture progress
  opencodeProcess = spawn("node", [OPENCODE_PATH, "serve", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: directory,
    detached: true,
  });
  
  opencodeProcess.stdout?.on("data", (data) => {
    const chunk = data.toString();
    opencodeLogs += chunk;
    // Keep only last 1000 characters to avoid memory issues
    if (opencodeLogs.length > 5000) opencodeLogs = opencodeLogs.slice(-5000);
  });

  opencodeProcess.stderr?.on("data", (data) => {
    opencodeLogs += data.toString();
  });

  opencodeProcess.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const ready = await new Promise<boolean>((resolve) => {
      const req = http.get(`http://localhost:${port}/session`, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => resolve(false));
      req.end();
    });
    if (ready) {
      console.log(`[ORCHESTRATOR] OpenCode server is ready on port ${port}.`);
      return;
    }
  }
  throw new Error(`OpenCode server failed to start on port ${port}`);
}

/**
 * Sends a prompt message to the OpenCode session.
 */
export async function sendToPort(
  port: number,
  sessionId: string,
  prompt: string,
): Promise<string> {
  const data = JSON.stringify({ parts: [{ type: "text", text: prompt }] });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "localhost",
      port: port,
      path: `/session/${sessionId}/message`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 15 * 60 * 1000,
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          reject(
            new Error(`OpenCode error: ${res.statusCode} ${res.statusMessage}`),
          );
          return;
        }
        try {
          const parsed = JSON.parse(body);
          const text =
            parsed.parts?.find((p: any) => p.type === "text")?.text || "";
          resolve(text);
        } catch (e) {
          reject(
            new Error(
              `Failed to parse OpenCode response: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        }
      });
    });

    req.on("error", (e) => {
      reject(e);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("OpenCode request timed out after 15 minutes"));
    });

    req.write(data);
    req.end();
  });
}

/**
 * Creates a new OpenCode session via API.
 */
export async function createSession(
  port: number,
  directory: string,
  model?: string,
): Promise<string> {
  const bodyData: any = { directory };
  if (model) bodyData.model = model;

  const data = JSON.stringify(bodyData);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "localhost",
      port: port,
      path: "/session",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 5 * 60 * 1000,
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          reject(
            new Error(
              `Failed to create session: ${res.statusCode} ${res.statusMessage} - Body: ${body}`,
            ),
          );
          return;
        }
        try {
          const parsed = JSON.parse(body);
          if (!parsed.id) {
            reject(new Error("Session creation response missing 'id'"));
          } else {
            resolve(parsed.id);
          }
        } catch (e) {
          reject(
            new Error(
              `Failed to parse session response: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        }
      });
    });

    req.on("error", (e) => {
      reject(e);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Session creation timed out"));
    });

    req.write(data);
    req.end();
  });
}

/**
 * Generates an opencode.json config to grant full permissions.
 */
export function writeOpencodeConfig(targetDirectory: string): void {
  const opencodeJsonPath = path.join(targetDirectory, "opencode.json");
  const opencodeConfig = {
    $schema: "https://opencode.ai/config.json",
    permission: "allow",
    model: "google/gemma-4-31b-it" 
  };

  fs.writeFileSync(
    opencodeJsonPath,
    JSON.stringify(opencodeConfig, null, 2),
    "utf8",
  );
}

/**
 * Clones the given GitHub repo and generates an opencode.json config.
 */
export async function cloneRepoForDiskWork(
  owner: string,
  repo: string,
): Promise<string> {
  const cloneDir = path.join("/tmp", "repoorbit_sandbox", `${owner}_${repo}`);

  if (!fs.existsSync(cloneDir)) {
    fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
    const { execSync } = await import("child_process");
    const cloneUrl = `https://github.com/${owner}/${repo}.git`;
    execSync(`git clone ${cloneUrl} ${cloneDir}`, { stdio: "pipe" });
  }

  // Permission Injection
  writeOpencodeConfig(cloneDir);

  return cloneDir;
}

/**
 * Returns the latest logs from the OpenCode server.
 */
export function getOpenCodeLogs(): string {
  return opencodeLogs;
}
