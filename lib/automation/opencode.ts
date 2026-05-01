export async function sendToPort(
  port: number,
  sessionId: string,
  prompt: string,
): Promise<string> {
  // Use a very long timeout (15 minutes) as disk operations/builds take time
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15 * 60 * 1000);

  try {
    const res = await fetch(
      `http://localhost:${port}/session/${sessionId}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
        signal: controller.signal,
      },
    );
    
    if (!res.ok) {
      throw new Error(`OpenCode error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    // Extract text response
    const text = data.parts?.find((p: any) => p.type === "text")?.text || "";
    return text;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function createSession(
  port: number,
  directory: string,
  model?: string,
): Promise<string> {
  const body: Record<string, string> = { directory };
  if (model) body.model = model;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000);

  try {
    const res = await fetch(`http://localhost:${port}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Failed to create session: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    return data.id;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Clones the given GitHub repo into ~/  (e.g. ~/repoorbit).
 * If the directory already exists it is left as-is so previous runs
 * are not wiped out mid-session.
 * Returns the absolute path of the cloned repo.
 */
export async function cloneRepoForDiskWork(
  owner: string,
  repo: string,
): Promise<string> {
  const { execSync } = await import("child_process");
  const os = await import("os");
  const path = await import("path");
  const fs = await import("fs");

  const cloneDir = path.join(os.homedir(), repo);

  if (fs.existsSync(cloneDir)) {
    console.log(`[ORCHESTRATOR] Repo already cloned at ${cloneDir} — reusing existing disk state.`);
    return cloneDir;
  }

  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  console.log(`[ORCHESTRATOR] Cloning ${cloneUrl} into ${cloneDir}...`);
  execSync(`git clone ${cloneUrl} ${cloneDir}`, { stdio: "pipe" });
  console.log(`[ORCHESTRATOR] Clone complete: ${cloneDir}`);
  return cloneDir;
}
