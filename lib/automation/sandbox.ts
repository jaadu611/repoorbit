import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Clones the given GitHub repo into a unique, isolated sandbox directory.
 * Standardizes on /tmp/repoorbit_sandboxes/[taskId]
 */
export async function cloneRepoForDiskWork(
  owner: string,
  repo: string,
  taskId: string,
): Promise<string> {
  const sandboxRoot = path.join(os.tmpdir(), "repoorbit_sandboxes");
  const cloneDir = path.join(sandboxRoot, taskId, `${owner}_${repo}`);

  console.log(`[SANDBOX] Initializing: ${cloneDir}`);

  if (!fs.existsSync(cloneDir)) {
    fs.mkdirSync(cloneDir, { recursive: true });
    
    const { execSync } = await import("child_process");
    const cloneUrl = `https://github.com/${owner}/${repo}.git`;
    
    try {
      console.log(`[SANDBOX] Cloning ${cloneUrl}...`);
      execSync(`git clone --depth 1 ${cloneUrl} ${cloneDir}`, { stdio: "pipe" });
      console.log(`[SANDBOX] Clone successful.`);
    } catch (err: any) {
      console.error(`[SANDBOX] Clone FAILED:`, err.message);
      throw err;
    }
  }

  return cloneDir;
}

/**
 * Securely removes the isolated sandbox directory for a task.
 */
export function cleanupSandbox(taskId: string): void {
  const sandboxPath = path.join(os.tmpdir(), "repoorbit_sandboxes", taskId);
  try {
    if (fs.existsSync(sandboxPath)) {
      console.log(`[SANDBOX] Cleaning up ${taskId}...`);
      fs.rmSync(sandboxPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`[SANDBOX] Cleanup failed:`, err);
  }
}
