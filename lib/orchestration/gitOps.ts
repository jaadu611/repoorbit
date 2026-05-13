import { exec as execRaw } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const exec = promisify(execRaw);

export interface DiffSummary {
  raw: string;          // full git diff
  stat: string;         // git diff --stat
  filesChanged: string[];
  additions: number;
  deletions: number;
}

export interface GitOpsResult {
  branchName: string;
  commitSha: string;
  prUrl: string | null;
  prNumber: number | null;
}

/**
 * Returns the git diff summary after surgery to give the reviewer
 * ground-truth of what actually changed on disk.
 */
export async function getGitDiff(repoWorkDir: string): Promise<DiffSummary> {
  const run = async (cmd: string) => {
    try {
      const { stdout } = await exec(cmd, { cwd: repoWorkDir, timeout: 30_000 });
      return stdout.trim();
    } catch {
      return "";
    }
  };

  const [stat, rawDiff] = await Promise.all([
    run("git diff --stat HEAD"),
    run("git diff HEAD"),
  ]);

  // Also include staged / untracked
  const [statFull, rawFull] = await Promise.all([
    run("git status --short"),
    run("git diff"),
  ]);

  const combinedStat = stat || statFull;
  const combinedDiff = (rawDiff + "\n" + rawFull).trim().slice(0, 20_000);

  // Parse files changed
  const filesChanged: string[] = [];
  const addDel = { additions: 0, deletions: 0 };
  for (const line of combinedStat.split("\n")) {
    if (!line.trim()) continue;
    
    // Pattern 1: git diff --stat (e.g. " lib/utils.ts | 10 +++")
    const mStat = line.match(/^\s*(\S+.*?)\s*\|/);
    if (mStat) {
      filesChanged.push(mStat[1].trim());
    } else {
      // Pattern 2: git status --short (e.g. " M lib/utils.ts" or "?? newfile.ts")
      // We skip the first 3 chars which are the status flags
      const pathPart = line.slice(3).trim();
      if (pathPart && !filesChanged.includes(pathPart)) {
        filesChanged.push(pathPart);
      }
    }
    
    const nums = line.match(/(\d+) insertion|(\d+) deletion/g);
    if (nums) {
      nums.forEach((n) => {
        if (n.includes("insertion")) addDel.additions += parseInt(n);
        else addDel.deletions += parseInt(n);
      });
    }
  }

  return {
    raw: combinedDiff,
    stat: combinedStat,
    filesChanged,
    additions: addDel.additions,
    deletions: addDel.deletions,
  };
}

/**
 * Installs npm dependencies in the sandbox if node_modules is missing.
 * Uses npm ci when lock file exists, falls back to npm install.
 */
export async function ensureDepsInstalled(
  repoWorkDir: string,
  onStatus: (msg: string) => void,
): Promise<void> {
  const hasPkg = fs.existsSync(path.join(repoWorkDir, "package.json"));
  if (!hasPkg) return;

  const hasModules = fs.existsSync(path.join(repoWorkDir, "node_modules"));
  if (hasModules) {
    onStatus("Dependencies already installed. Skipping npm install.");
    return;
  }

  const hasLock = fs.existsSync(path.join(repoWorkDir, "package-lock.json"));
  const cmd = hasLock ? "npm ci --prefer-offline" : "npm install --legacy-peer-deps";

  onStatus(`Installing dependencies (${hasLock ? "npm ci" : "npm install"})...`);
  try {
    await exec(cmd, {
      cwd: repoWorkDir,
      timeout: 5 * 60_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, NODE_ENV: "development" },
    });
    onStatus("Dependencies installed successfully.");
  } catch (err: any) {
    // Non-fatal — tests might still run
    onStatus(`⚠️ Dependency install warnings: ${err.message.slice(0, 200)}`);
  }
}

/**
 * Creates a branch, commits all changes, pushes, and opens a PR.
 * Returns the PR URL or null if no GITHUB_TOKEN is set.
 */
export async function commitAndCreatePR(
  owner: string,
  repo: string,
  repoWorkDir: string,
  query: string,
  diffSummary: DiffSummary,
  onStatus: (msg: string) => void,
): Promise<GitOpsResult> {
  const token = process.env.GITHUB_TOKEN || process.env.NEXT_PUBLIC_GITHUB_TOKEN;
  const timestamp = Date.now();
  const slugQuery = query.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const branchName = `repoorbit/${slugQuery}-${timestamp}`;

  const run = async (cmd: string, allowFail = false) => {
    try {
      const { stdout } = await exec(cmd, { cwd: repoWorkDir, timeout: 60_000 });
      return stdout.trim();
    } catch (err: any) {
      if (!allowFail) throw err;
      return "";
    }
  };

  // Configure git identity
  await run(`git config user.email "repoorbit-bot@repoorbit.app"`, true);
  await run(`git config user.name "RepoOrbit Bot"`, true);

  onStatus(`Git — Creating branch: ${branchName}`);
  await run(`git checkout -b ${branchName}`);

  onStatus("Git — Staging all changes...");
  await run("git add -A");

  // Build commit message
  const changedFilesList = diffSummary.filesChanged.slice(0, 10).join(", ");
  const commitMsg = [
    `feat(repoorbit): ${query.slice(0, 72)}`,
    "",
    `Changes applied by RepoOrbit autonomous agent.`,
    `Files changed: ${changedFilesList}${diffSummary.filesChanged.length > 10 ? ` (+${diffSummary.filesChanged.length - 10} more)` : ""}`,
    `+${diffSummary.additions} lines / -${diffSummary.deletions} lines`,
  ].join("\n");

  onStatus("Git — Committing changes...");
  await run(`git commit -m "${commitMsg.replace(/"/g, "'")}"`);

  const commitSha = await run("git rev-parse HEAD");
  onStatus(`Git — Committed: ${commitSha.slice(0, 8)}`);

  if (!token) {
    onStatus("⚠️ No GITHUB_TOKEN set — skipping push and PR creation. Changes committed locally only.");
    return { branchName, commitSha, prUrl: null, prNumber: null };
  }

  // Set remote with token
  const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  await run(`git remote set-url origin "${remoteUrl}"`, true);

  onStatus(`Git — Pushing branch ${branchName}...`);
  await run(`git push origin ${branchName} --force`);
  onStatus("Git — Push successful.");

  // Create PR via GitHub REST API
  onStatus("Git — Creating Pull Request...");
  const prBody = [
    `## 🤖 RepoOrbit Autonomous Change`,
    "",
    `**Task:** ${query}`,
    "",
    `### Files Changed`,
    diffSummary.filesChanged.map((f) => `- \`${f}\``).join("\n"),
    "",
    `### Stats`,
    `- **+${diffSummary.additions}** additions`,
    `- **-${diffSummary.deletions}** deletions`,
    "",
    `### Diff Summary`,
    "```",
    diffSummary.stat.slice(0, 2000),
    "```",
    "",
    `---`,
    `*This PR was created automatically by [RepoOrbit](https://repoorbit.app)*`,
  ].join("\n");

  const prPayload = JSON.stringify({
    title: `[RepoOrbit] ${query.slice(0, 72)}`,
    body: prBody,
    head: branchName,
    base: "main",
    draft: false,
  });

  const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "RepoOrbit",
    },
    body: prPayload,
  });

  if (!prRes.ok) {
    const errText = await prRes.text();
    onStatus(`⚠️ PR creation failed: ${prRes.status} — ${errText.slice(0, 200)}`);
    return { branchName, commitSha, prUrl: null, prNumber: null };
  }

  const prData = await prRes.json();
  const prUrl = prData.html_url as string;
  const prNumber = prData.number as number;

  onStatus(`✓ PR created: ${prUrl}`);
  return { branchName, commitSha, prUrl, prNumber };
}

/**
 * Rolls back all uncommitted changes in the sandbox.
 * Used as a safety net when tests fail after max attempts.
 */
export async function rollbackChanges(
  repoWorkDir: string,
  onStatus: (msg: string) => void,
): Promise<void> {
  onStatus("⚠️ Rolling back all changes to last clean state...");
  try {
    await exec("git checkout -- .", { cwd: repoWorkDir, timeout: 30_000 });
    await exec("git clean -fd", { cwd: repoWorkDir, timeout: 30_000 });
    onStatus("Rollback complete. Sandbox restored to original state.");
  } catch (err: any) {
    onStatus(`Rollback failed: ${err.message}`);
  }
}

/**
 * Generates a human-readable Markdown diff summary for the UI.
 */
export function buildDiffSummaryMarkdown(diff: DiffSummary): string {
  const lines = [
    `## 📝 Changes Made`,
    "",
    `**${diff.filesChanged.length} file(s) modified** | ` +
      `**+${diff.additions}** additions | **-${diff.deletions}** deletions`,
    "",
    "### Files",
    ...diff.filesChanged.map((f) => `- \`${f}\``),
    "",
    "### Diff",
    "```diff",
    diff.raw.slice(0, 8000),
    "```",
  ];
  return lines.join("\n");
}

/**
 * Appends a new entry to CHANGELOG.md (if it exists) following Keep a Changelog format.
 * Then amends the current commit so the changelog is part of the same PR.
 */
export async function appendChangelog(
  repoWorkDir: string,
  query: string,
  diff: DiffSummary,
  prUrl: string | null,
  onStatus: (msg: string) => void,
): Promise<void> {
  const changelogPaths = [
    path.join(repoWorkDir, "CHANGELOG.md"),
    path.join(repoWorkDir, "changelog.md"),
    path.join(repoWorkDir, "CHANGELOG"),
  ];

  const changelogPath = changelogPaths.find((p) => fs.existsSync(p));

  const today = new Date().toISOString().split("T")[0];
  const prLink = prUrl ? ` ([PR](${prUrl}))` : "";

  const newEntry = [
    `## [Unreleased] — ${today}${prLink}`,
    "",
    `### Changed`,
    `- ${query.slice(0, 120)}`,
    "",
    "**Files modified:**",
    ...diff.filesChanged.slice(0, 20).map((f) => `- \`${f}\``),
    diff.filesChanged.length > 20
      ? `- *(+${diff.filesChanged.length - 20} more)*`
      : "",
    "",
    `*Applied by [RepoOrbit](https://repoorbit.app) autonomous agent.*`,
    "",
    "---",
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");

  if (changelogPath) {
    onStatus(`Changelog — Updating ${path.basename(changelogPath)}...`);
    const existing = fs.readFileSync(changelogPath, "utf-8");

    // Insert after the first heading line (e.g. "# Changelog")
    const firstHeadingIdx = existing.indexOf("\n");
    const updated =
      firstHeadingIdx > -1
        ? existing.slice(0, firstHeadingIdx + 1) + "\n" + newEntry + existing.slice(firstHeadingIdx + 1)
        : newEntry + existing;

    fs.writeFileSync(changelogPath, updated, "utf-8");
  } else {
    // Create a minimal CHANGELOG.md from scratch
    onStatus("Changelog — Creating CHANGELOG.md...");
    const freshChangelog = [
      "# Changelog",
      "",
      "> All notable changes to this project are documented here.",
      "> Format follows [Keep a Changelog](https://keepachangelog.com).",
      "",
      "---",
      "",
      newEntry,
    ].join("\n");

    fs.writeFileSync(path.join(repoWorkDir, "CHANGELOG.md"), freshChangelog, "utf-8");
  }

  // Stage and amend the commit to include the changelog
  try {
    const changelogFile = changelogPath ?? path.join(repoWorkDir, "CHANGELOG.md");
    await exec(`git add "${changelogFile}"`, { cwd: repoWorkDir, timeout: 15_000 });
    await exec(`git commit --amend --no-edit`, { cwd: repoWorkDir, timeout: 15_000 });
    onStatus("Changelog — Amended commit with CHANGELOG update.");
  } catch (err: any) {
    // Non-fatal — log but don't block the delivery
    onStatus(`Changelog — Could not amend commit: ${err.message.slice(0, 100)}`);
  }
}
