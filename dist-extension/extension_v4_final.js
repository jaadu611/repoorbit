"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"));
var path2 = __toESM(require("path"));
var fs = __toESM(require("fs"));
var import_child_process = require("child_process");

// src/lib/core/github.ts
var import_path = __toESM(require("path"));
function getHeaders(explicitToken) {
  const token = explicitToken || process.env.GITHUB_TOKEN || process.env.NEXT_PUBLIC_GITHUB_TOKEN;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "RepoOrbit",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (token) {
    const cleanToken = token.trim().replace(/^["']|["']$/g, "");
    if (cleanToken && cleanToken !== "undefined" && cleanToken !== "null") {
      headers["Authorization"] = `Bearer ${cleanToken}`;
    }
  }
  return headers;
}
var withCache = { next: { revalidate: 3600 } };
var noCache = { cache: "no-store" };
function safeJson(res) {
  return res?.ok ? res.json() : Promise.resolve(null);
}
function parseRepoInput(input) {
  const cleaned = input.trim().replace(/\/$/, "").replace(/\.git$/, "");
  const urlMatch = cleaned.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (urlMatch) return { owner: urlMatch[1].trim(), repo: urlMatch[2].trim() };
  const parts = cleaned.split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };
  throw new Error(`Invalid repo input: "${input}"`);
}
function buildExtFreq(tree) {
  const freq = {};
  for (const item of tree) {
    if (item.type !== "blob") continue;
    const name = item.path.split("/").pop() ?? "";
    if (!name.includes(".")) continue;
    const ext = name.split(".").pop().toLowerCase();
    freq[ext] = (freq[ext] ?? 0) + 1;
  }
  return freq;
}
function buildStackFlags(paths) {
  const s = paths.map((p) => p.toLowerCase());
  const has = (test) => s.some(test);
  return {
    hasLockfile: has(
      (p) => p === "package-lock.json" || p === "yarn.lock" || p === "pnpm-lock.yaml"
    ),
    hasDocker: has(
      (p) => p?.includes("dockerfile") || p === "docker-compose.yml" || p === "docker-compose.yaml"
    ),
    hasTailwind: has((p) => p?.includes("tailwind.config")),
    hasNextjs: has((p) => p?.includes("next.config")),
    hasVite: has((p) => p?.includes("vite.config")),
    hasWebpack: has((p) => p?.includes("webpack.config")),
    hasPrisma: has((p) => p?.endsWith("schema.prisma")),
    hasEnvFile: has(
      (p) => p === ".env" || p === ".env.example" || p === ".env.local"
    ),
    hasGitActions: has((p) => !!p?.startsWith(".github/workflows")),
    hasTests: has((p) => !!(p && /test|spec|__tests__|jest|vitest/.test(p))),
    hasReadme: has((p) => p === "readme.md"),
    architecture: has((p) => p.includes("next.config")) ? "Next.js" : has((p) => p.includes("vite.config")) ? "Vite" : has((p) => p === "package-lock.json" || p === "yarn.lock") ? "Node.js" : "General"
  };
}
async function fetchCommitsForAuthor(owner, repo, login, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?author=${login}&per_page=15&page=1`;
  try {
    const res = await fetch(url, { headers: getHeaders(token), ...withCache });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    if (!Array.isArray(data)) return [];
    return data.map((c) => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: c.commit?.message ?? "",
      author: c.commit?.author?.name ?? login,
      authorEmail: c.commit?.author?.email ?? "",
      date: c.commit?.author?.date ?? "",
      htmlUrl: c.html_url ?? "",
      avatarUrl: c.author?.avatar_url ?? null,
      profileUrl: c.author?.html_url ?? null
    }));
  } catch {
    return [];
  }
}
async function fetchCommitsForPath(owner, repo, path3, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path3)}&per_page=15`;
  try {
    const res = await fetch(url, { headers: getHeaders(token), ...withCache });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    if (!Array.isArray(data)) return [];
    return data.map((c) => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: c.commit?.message ?? "",
      author: c.commit?.author?.name ?? c.author?.login ?? "Unknown",
      authorEmail: c.commit?.author?.email ?? "",
      date: c.commit?.author?.date ?? "",
      htmlUrl: c.html_url ?? "",
      avatarUrl: c.author?.avatar_url ?? null,
      profileUrl: c.author?.html_url ?? null
    }));
  } catch {
    return [];
  }
}
async function fetchFileContent(owner, repo, path3, ref = "main", token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path3)}?ref=${ref}`;
  try {
    const res = await fetch(url, {
      headers: { ...getHeaders(token), Accept: "application/vnd.github.raw" },
      ...noCache
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
function resolveImportPath(importPath, fromFile, fileSet) {
  if (!importPath || !fileSet) return null;
  if (!importPath.startsWith(".") && !importPath.startsWith("@")) return null;
  const baseDir = import_path.default.dirname(fromFile);
  let resolved = importPath.startsWith("@/") ? importPath.replace("@/", "") : import_path.default.join(baseDir, importPath);
  if (resolved.startsWith("/")) resolved = resolved.slice(1);
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".py"];
  for (const ext of extensions) {
    const full = resolved + ext;
    if (fileSet.has(full)) return full;
  }
  for (const ext of extensions) {
    const indexFile = import_path.default.join(resolved, "index" + ext);
    if (fileSet.has(indexFile)) return indexFile;
  }
  return null;
}
function parseImports(content, filePath, fileSet) {
  const imports = /* @__PURE__ */ new Set();
  const patterns = [
    /import\s+.*?\s+from\s+['"](.*?)['"]/g,
    /require\(['"](.*?)['"]\)/g,
    /import\(['"](.*?)['"]\)/g,
    /export\s+\*\s+from\s+['"](.*?)['"]/g,
    /export\s+{[^}]+}\s+from\s+['"](.*?)['"]/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const raw = match[1];
      const resolved = resolveImportPath(raw, filePath, fileSet);
      if (resolved) imports.add(resolved);
    }
  }
  return Array.from(imports);
}
function analyzeFile(filename, content, fileSet) {
  const imports = parseImports(content, filename, fileSet);
  const lines = content.split("\n");
  const functionCount = (content.match(/\bfunction\b|\b=>\s*[{(]/g) ?? []).length;
  const classCount = (content.match(/\bclass\s+\w+/g) ?? []).length;
  const isReact = /import\s+.*React|from\s+['"]react['"]/.test(content);
  const isTest = /\.(test|spec)\.[a-z]+$/.test(filename) || /describe\(|it\(|test\(/.test(content);
  const isConfig = /config|\.env|rc\b/.test(filename.toLowerCase());
  const isTypeScript = /\.(ts|tsx)$/.test(filename);
  const hasJsx = /\.(tsx|jsx)$/.test(filename) || /<[A-Z][A-Za-z0-9]*\s*\/?>/.test(content);
  const exportMatches = content.matchAll(
    /export\s+(?:default\s+)?(?:async\s+)?(?:(function|class|type|interface|enum)\s+(\w+)|const\s+(\w+)\s*=)/g
  );
  const exportsLine = [...exportMatches].map((m) => (m[2] ?? m[3] ?? "").trim()).filter(Boolean);
  const todoComments = (content.match(/\/\/.*TODO:?.*$|#.*TODO:?.*$/gm) ?? []).map((t) => t.replace(/^\s*\/\/\s*|^\s*#\s*/, ""));
  const commentLines = lines.filter((l) => /^\s*(\/\/|#|\/\*)/.test(l)).length;
  const emptyLines = lines.filter((l) => !l.trim()).length;
  const codeLines = lines.length - commentLines - emptyLines;
  return {
    exports: exportsLine,
    todoComments,
    functionCount,
    classCount,
    isReact,
    isTest,
    isConfig,
    isTypeScript,
    imports,
    hasJsx,
    lineCount: lines.length,
    codeLines,
    emptyLines,
    commentLines,
    charCount: content.length
  };
}
var getRepoData = async (owner, repo, token) => {
  const url = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = getHeaders(token);
  const repoRes = await fetch(url, { headers, ...withCache });
  if (!repoRes.ok) {
    const errorBody = await repoRes.json().catch(() => ({}));
    console.error({
      status: repoRes.status,
      errorBody,
      url
    });
    const reason = repoRes.status === 403 ? "Rate limited \u2014 add a GITHUB_TOKEN to your .env" : repoRes.status === 404 ? "Repo not found \u2014 check the owner/repo name" : `GitHub API error (${repoRes.status})`;
    throw new Error(reason);
  }
  const repoData = await repoRes.json();
  const defaultBranch = repoData.default_branch;
  const [
    treeRes,
    readmeRes,
    commitsRes,
    contributorsRes,
    languagesRes,
    releasesRes,
    branchesRes,
    issuesRes,
    pullsRes
  ] = await Promise.allSettled([
    fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`,
      { headers: getHeaders(token), ...noCache }
    ),
    fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
      headers: { ...getHeaders(token), Accept: "application/vnd.github.raw" },
      ...withCache
    }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=30`, {
      headers: getHeaders(token),
      ...withCache
    }),
    fetch(
      `https://api.github.com/repos/${owner}/${repo}/contributors?per_page=20`,
      { headers: getHeaders(token), ...withCache }
    ),
    fetch(`https://api.github.com/repos/${owner}/${repo}/languages`, {
      headers: getHeaders(token),
      ...withCache
    }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=5`, {
      headers: getHeaders(token),
      ...withCache
    }),
    fetch(
      `https://api.github.com/repos/${owner}/${repo}/branches?per_page=30`,
      { headers: getHeaders(token), ...withCache }
    ),
    fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=30&pulls=false`,
      { headers: getHeaders(token), ...withCache }
    ),
    fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&per_page=30`,
      { headers: getHeaders(token), ...withCache }
    )
  ]);
  const treeValue = treeRes.status === "fulfilled" ? treeRes.value : null;
  const readmeValue = readmeRes.status === "fulfilled" ? readmeRes.value : null;
  if (!treeValue?.ok) {
    const status = treeValue?.status;
    const errorBody = await treeValue?.json().catch(() => ({}));
    const reason = status === 403 ? `GitHub API error: ${errorBody.message || "Rate limited or tree too large"} \u2014 add a GITHUB_TOKEN to your .env` : status === 404 ? "Repo tree not found" : `Tree fetch failed (${status ?? "network error"})`;
    throw new Error(reason);
  }
  const [
    treeData,
    commitsData,
    contributorsData,
    languagesData,
    releasesData,
    branchesData,
    issuesData,
    pullsData
  ] = await Promise.all([
    treeValue.json(),
    safeJson(commitsRes.status === "fulfilled" ? commitsRes.value : null),
    safeJson(
      contributorsRes.status === "fulfilled" ? contributorsRes.value : null
    ),
    safeJson(languagesRes.status === "fulfilled" ? languagesRes.value : null),
    safeJson(releasesRes.status === "fulfilled" ? releasesRes.value : null),
    safeJson(branchesRes.status === "fulfilled" ? branchesRes.value : null),
    safeJson(issuesRes.status === "fulfilled" ? issuesRes.value : null),
    safeJson(pullsRes.status === "fulfilled" ? pullsRes.value : null)
  ]);
  const readmeText = readmeValue?.ok ? await readmeValue.text() : "No README available.";
  const contributorLogins = Array.isArray(contributorsData) ? contributorsData.map((c) => c.login) : [];
  const commitsByAuthorEntries = await Promise.all(
    contributorLogins.map(async (login) => {
      const commits = await fetchCommitsForAuthor(owner, repo, login, token);
      return [login, commits];
    })
  );
  const commitsByAuthor = Object.fromEntries(
    commitsByAuthorEntries
  );
  const totalCommitsFetched = Object.values(commitsByAuthor).reduce(
    (sum, commits) => sum + commits.length,
    0
  );
  const rawTree = treeData.tree ?? [];
  const allPaths = rawTree.map((n) => n.path);
  const flatTree = rawTree.map((n) => {
    const parts = n.path.split("/");
    const namePart = parts[parts.length - 1] || "";
    const isFolder = n.type === "tree";
    const ext = !isFolder && namePart.includes(".") ? (namePart.split(".").pop() || "").toLowerCase() : "";
    return {
      path: n.path,
      name: namePart,
      type: isFolder ? "folder" : "file",
      ext,
      size: n.size ?? 0,
      depth: parts.length,
      sha: n.sha
    };
  });
  const allFiles = flatTree.filter((e) => e.type === "file");
  const allFolders = flatTree.filter((e) => e.type === "folder");
  const rootItems = flatTree.filter((e) => e.depth === 1);
  const extFreq = buildExtFreq(rawTree);
  const stack = buildStackFlags(allPaths);
  const langMap = languagesData ?? {};
  const langTotal = Object.values(langMap).reduce(
    (a, b) => a + b,
    0
  );
  const languages = Object.entries(langMap).map(([lang, bytes]) => ({
    lang,
    bytes,
    pct: langTotal > 0 ? Math.round(bytes / langTotal * 1e3) / 10 : 0
  })).sort((a, b) => b.bytes - a.bytes);
  const latestCommitRaw = Array.isArray(commitsData) ? commitsData[0] : null;
  const releases = Array.isArray(releasesData) ? releasesData : [];
  const issues = Array.isArray(issuesData) ? issuesData.filter((i) => !i.pull_request).map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    author: i.user?.login ?? null,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    closedAt: i.closed_at ?? null,
    labels: (i.labels ?? []).map((l) => l.name),
    comments: i.comments,
    htmlUrl: i.html_url,
    body: i.body ? i.body.slice(0, 500) : null
  })) : [];
  const pulls = Array.isArray(pullsData) ? pullsData.map((p) => ({
    number: p.number,
    title: p.title,
    state: p.state,
    merged: p.merged_at !== null,
    author: p.user?.login ?? null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    mergedAt: p.merged_at ?? null,
    closedAt: p.closed_at ?? null,
    baseBranch: p.base?.ref ?? null,
    headBranch: p.head?.ref ?? null,
    labels: (p.labels ?? []).map((l) => l.name),
    comments: p.comments,
    htmlUrl: p.html_url,
    body: p.body ? p.body.slice(0, 500) : null
  })) : [];
  const repoContext = {
    meta: {
      name: repoData.name,
      fullName: repoData.full_name,
      owner: repoData.owner.login,
      avatar: repoData.owner.avatar_url,
      stars: repoData.stargazers_count,
      forks: repoData.forks_count,
      openIssues: repoData.open_issues_count,
      size: repoData.size,
      pushedAt: repoData.pushed_at,
      language: repoData.language ?? "",
      license: repoData.license?.spdx_id ?? repoData.license?.name ?? "No License",
      defaultBranch,
      visibility: repoData.visibility
    },
    github: {
      description: repoData.description ?? null,
      homepage: repoData.homepage ?? null,
      topics: repoData.topics ?? [],
      createdAt: repoData.created_at,
      updatedAt: repoData.updated_at,
      pushedAt: repoData.pushed_at,
      htmlUrl: repoData.html_url
    },
    latestCommit: latestCommitRaw ? {
      sha: latestCommitRaw.sha,
      shortSha: latestCommitRaw.sha.slice(0, 7),
      message: latestCommitRaw.commit.message,
      author: latestCommitRaw.commit.author.name,
      authorEmail: latestCommitRaw.commit.author.email,
      date: latestCommitRaw.commit.author.date,
      htmlUrl: latestCommitRaw.html_url,
      avatarUrl: latestCommitRaw.author?.avatar_url ?? null,
      profileUrl: latestCommitRaw.author?.html_url ?? null
    } : null,
    recentCommits: Array.isArray(commitsData) ? commitsData.map((c) => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: c.commit.message,
      author: c.commit.author.name,
      date: c.commit.author.date,
      htmlUrl: c.html_url
    })) : [],
    commitsByAuthor,
    totalCommitsFetched,
    contributors: Array.isArray(contributorsData) ? contributorsData.map((c) => ({
      login: c.login,
      avatarUrl: c.avatar_url,
      profileUrl: c.html_url,
      contributions: c.contributions
    })) : [],
    languages,
    releases: releases.map((r) => ({
      tagName: r.tag_name,
      name: r.name,
      publishedAt: r.published_at,
      htmlUrl: r.html_url,
      prerelease: r.prerelease,
      draft: r.draft
    })),
    latestRelease: releases[0] ? {
      tagName: releases[0].tag_name,
      name: releases[0].name,
      publishedAt: releases[0].published_at,
      htmlUrl: releases[0].html_url,
      prerelease: releases[0].prerelease,
      draft: releases[0].draft
    } : null,
    branches: Array.isArray(branchesData) ? branchesData.map((b) => ({
      name: b.name,
      protected: b.protected
    })) : [],
    issues,
    pulls,
    tree: flatTree,
    stats: {
      totalFiles: allFiles.length,
      totalFolders: allFolders.length,
      totalSize: allFiles.reduce((acc, e) => acc + e.size, 0),
      maxDepth: flatTree.reduce((acc, e) => Math.max(acc, e.depth), 0),
      rootItemCount: rootItems.length,
      extFrequency: extFreq,
      dominantExt: Object.entries(extFreq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    },
    stack: {
      ...stack,
      entryPoints: rootItems.filter((e) => /^(index|main|app|page)\./i.test(e.name)).map((e) => e.name)
    }
  };
  const nestedTree = [];
  const treeMap = {};
  flatTree.forEach((item) => {
    const parts = item.path.split("/");
    let currentLevel = nestedTree;
    let currentPath = "";
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFolder = index < parts.length - 1 || item.type === "folder";
      if (!treeMap[currentPath]) {
        const newNode = {
          name: part,
          path: currentPath,
          type: isFolder ? "folder" : "file",
          sha: isFolder ? void 0 : item.sha,
          ext: !isFolder ? (part.split(".").pop() || "").toLowerCase() : void 0,
          size: !isFolder ? item.size || 0 : 0,
          children: isFolder ? [] : void 0
        };
        treeMap[currentPath] = newNode;
        currentLevel.push(newNode);
      }
      if (isFolder) {
        currentLevel = treeMap[currentPath].children;
      }
    });
  });
  const filesMetadata = flatTree.filter((item) => item.type === "file").map((item) => ({
    path: item.path,
    name: item.name,
    size: Number(item.size) || 0,
    sha: item.sha,
    ext: item.ext,
    depth: item.depth
  }));
  return {
    tree: nestedTree,
    readme: readmeText,
    metadata: repoContext.meta,
    repoContext,
    filesMetadata,
    importGraph: {}
  };
};

// src/lib/core/constants/master.ts
var MASTER_MD_CONTENT = `---
trigger: always_on
glob: "*"
description: Global Constitution & Agentic Protocols
---

# Global Constitution & Agentic Protocols

1. Always follow the established Global Rules
2. Respect the DNA and style of the existing project.
3. Always deliver clean, warning-free implementations.
4. **Scope Validation**: Always check if the raised issue or review comment is related to the codebase itself or is a system/environment issue on the user's machine. If it is an environmental/machine issue, do not change the codebase; always proceed with caution and explain the situation.
5. **Implementation Planning**: Always proceed with the implementation plan you create. Do NOT wait for user input, approval, or feedback. Directly begin execution after creating/updating the implementation plan.

# GLOBAL CONSTITUTION: AGENTIC PROTOCOLS

## 1. THE "NO-YAPPING" PROTOCOL (Efficiency & Token Economy)

* **CORE COMMAND**: You must be ruthlessly direct and efficient. Your primary goal is to save tokens and minimize conversational noise.
* **ZERO FILLER**: Never use conversational filler such as "Certainly!", "I have updated the code," or "I hope this helps." If the user's request is clear, jump straight to the solution.
* **SILENT EXECUTION**: If a task (like creating a file or running a command) can be performed without explanation, **SAY ABSOLUTELY NOTHING**. Perform the action and wait for the next instruction.
* **HARSH CONSTRAINTS**: No politeness, no apologies, and **NEVER USE EMOJIS**. Use compact, information-dense bullet points only if an explanation is strictly required.

## 2. THE "TRUST BUT VERIFY" PROTOCOL (Operational Safety)

* **ACTION**: Never assume a command or edit succeeded simply because the terminal didn't crash.
* **MANDATORY VALIDATION**: You MUST run a verification step (e.g., ls, grep, npm test, tsc, or a build check) after **every single update**. Your job is to prove the change is correct, not just hope it is.
* **REGRESSION PREVENTION**: If a verification command (like a test suite) is available in the project, it is your responsibility to ensure it passes before you consider a task "Done." Fix any regressions immediately before moving to the next step.

## 3. THE "PRESERVATION" PROTOCOL (Code Integrity & Style)

* **GUEST MENTALITY**: You are a guest in this codebase. You must respect the existing "DNA" of the project.
* **STYLE MATCHING**: Automatically detect and match the project's existing indentation (Tabs vs. Spaces), naming conventions (camelCase, snake_case, etc.), and architectural patterns.
* **DOCUMENTATION HOLISTIC**: Never remove existing comments, JSDoc, or documentation unless they are directly invalidated by your code changes. If you update a function, update its documentation to match.

## 4. THE "NO GHOST ERRORS" PROTOCOL (Linting & Type Safety)

* **CLEAN ON ARRIVAL**: Your code must be delivered without warnings. A "fix" that introduces linting errors or type warnings is an incomplete fix.
* **LINTING COMPLIANCE**: If the project has a linter (ESLint, Prettier, etc.) or a type-checker (TypeScript, MyPy), you must run it on your changes.
* **ZERO WARNINGS**: If your update introduces 5 new warnings while fixing 1 bug, you have failed the protocol. Resolve all secondary issues before reporting completion.

## 5. THE "CONTEXT FIRST" PROTOCOL (Comprehensive Reading)

* **ANTI-BLIND EDITING**: Never edit code "in the dark." You must have a clear mental map of the surrounding logic before changing a single character.
* **READ DEPTH**: Before making a targeted edit, read the entire file (or at least 100 lines of context above and below the target area).
* **DEPENDENCY MAPPING**: Identify how the code you are changing interacts with other parts of the system. This prevents "ripple effect" bugs caused by missing context.

## 6. THE "SURGICAL EDIT" PROTOCOL (Minimal Diff Noise)

* **TASK FOCUS**: Stay laser-focused on the task provided. Do not engage in unsolicited refactoring or "cleanups" unless specifically instructed to do so.
* **MINIMAL DIFFS**: Propose the smallest, most efficient character-sequence change that solves the problem.
* **REASONING**: If a 3-line change suffices, do not rewrite the entire function. Your goal is to keep the Git history clean and the diffs easy for a human to review.

## 7. THE "LEAST POWER" PROTOCOL (Simplicity & Stability)

* **NATIVE FIRST**: Prefer simpler, native, and standard solutions over complex libraries.
* **DEPENDENCY DISCIPLINE**: Before adding a new package to package.json, check if an existing tool in the project can already solve the problem. Do not introduce 10MB of external code for a 5-line logic requirement.

## 8. THE "SILENT FAILURE" PROHIBITION (Robust Error Handling)

* **EXPLICIT CATCHING**: Never "swallow" an error. Every try/catch block must have a meaningful handler.
* **ACTIONABLE LOGGING**: If an error is caught, it must be logged with enough context to be debugged, or re-thrown to the appropriate handler. Empty catch {} blocks are strictly forbidden.

## 9. THE "CLARITY OVER CLEVERNESS" PROTOCOL (Human Readability)

* **FUTURE PROOFING**: Write code that is easy for humans to read, not code that shows off "clever" syntax.
* **NAMING**: Use descriptive, intentional names for variables and functions. Avoid magic numbers and obscure one-liners that prioritize brevity over clarity.

## 10. THE "IDEMPOTENT ACTION" PROTOCOL (Operational Safety)

* **REPEATABILITY**: Ensure your terminal commands are safe to run multiple times without causing side effects.
* **FLAGS**: Always use safety flags (e.g., mkdir -p instead of mkdir, rm -f instead of rm) to prevent script-breaking errors during automation.

## 11. THE "BINARY SEARCH" PROTOCOL (Systematic Investigation)

* **METHODICAL HUNTING**: Isolate problems by narrowing down the search space by half each step. Do not use "Shotgun Debugging" (changing many things and hoping one works).
* **RANKED HYPOTHESES**: When investigating, generate multiple hypotheses and rank them by likelihood before testing them one by one.`;

// src/lib/core/constants/queries.ts
var DEFAULT_QUERIES_CONTENT = `# How to enter your issues:
# 
# 1. Enter each issue or query on its own section.
# 2. Separate all issues with a line containing ---
# 
# Example:
# 
# First issue to analyze and fix
# 
# ---
# 
# Second issue to analyze and fix
`;

// src/extension.ts
var modelCache = null;
var cacheExpiry = 0;
var CACHE_TTL = 5 * 60 * 1e3;
var activeState = {
  messages: [],
  isPlaying: false,
  currentQueryIndex: -1,
  retryCount: 0,
  isLoading: false,
  repoUrl: "",
  forkOwner: "",
  upstreamOwner: "",
  upstreamRepo: "",
  branchName: "",
  defaultBranch: "",
  config: { model: "MODEL_PLACEHOLDER_M84" }
};
var currentWebview = void 0;
async function discoverLS() {
  try {
    const psOutput = (0, import_child_process.execSync)("ps -ax -o pid=,command=", { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const lsLine = psOutput.split("\n").find((l) => l.includes("language_server") && l.includes("antigravity"));
    if (!lsLine) return null;
    const pid = lsLine.trim().split(" ")[0];
    const csrfToken = lsLine.match(/--csrf_token\s+([a-f0-9-]+)/)?.[1];
    if (!pid || !csrfToken) return null;
    let ports = [];
    try {
      const ss = (0, import_child_process.execSync)(`ss -tunlp 2>/dev/null | grep "pid=${pid}"`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
      const matches = ss.match(/127\.0\.0\.1:(\d+)/g) || [];
      ports = [...new Set(matches.map((m) => m.split(":")[1]))].filter(Boolean);
    } catch {
      ports = ["34805", "45151", "40853"];
    }
    return { pid, csrfToken, ports };
  } catch (err) {
    console.error("[RepoOrbit] LS Discovery failed:", err);
    return null;
  }
}
async function secureRPCRequest(url, options) {
  const https = require("https");
  const http = require("http");
  const u = new URL(url);
  const protocol = u.protocol === "https:" ? https : http;
  const requestOptions = {
    hostname: u.hostname,
    port: u.port,
    path: u.pathname + u.search,
    method: options.method || "GET",
    headers: options.headers || {},
    rejectUnauthorized: false
    // Bypasses local self-signed certs
  };
  return new Promise((resolve, reject) => {
    const req = protocol.request(requestOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(data),
          text: async () => data
        });
      });
    });
    req.on("error", (err) => reject(err));
    if (options.body) req.write(options.body);
    req.end();
  });
}
async function fetchModelsHybrid() {
  if (modelCache && Date.now() < cacheExpiry) return modelCache;
  if (vscode.lm) {
    try {
      const lmModels = await vscode.lm.selectChatModels({});
      if (lmModels.length > 0) {
        modelCache = lmModels.map((m) => ({
          id: m.id,
          name: m.name || m.id,
          vendor: m.vendor || "Unknown"
        }));
        cacheExpiry = Date.now() + CACHE_TTL;
        console.log("[RepoOrbit] Models fetched via vscode.lm");
        return modelCache || [];
      }
    } catch (err) {
      console.warn("[RepoOrbit] vscode.lm model fetch failed:", err);
    }
  }
  const ls = await discoverLS();
  if (ls) {
    const metadata = { ideName: "antigravity", extensionName: "repoorbit", ideVersion: vscode.version, locale: "en" };
    const endpoint = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
    for (const port of ls.ports) {
      try {
        for (const proto of ["https", "http"]) {
          try {
            const res = await secureRPCRequest(`${proto}://127.0.0.1:${port}${endpoint}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Connect-Protocol-Version": "1",
                "x-codeium-csrf-token": ls.csrfToken
              },
              body: JSON.stringify({ metadata })
            });
            if (res.ok) {
              const data = await res.json();
              const cfgs = data?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
              if (cfgs?.length) {
                modelCache = cfgs.map((c) => {
                  const lbl = c.label || c.modelOrAlias?.model || "Unknown";
                  const quota = c.quotaInfo?.remainingFraction ?? "N/A";
                  const resetTime = c.quotaInfo?.resetTime;
                  return {
                    id: c.modelOrAlias?.model || lbl,
                    name: lbl,
                    vendor: lbl.toLowerCase().includes("gemini") ? "Google" : lbl.toLowerCase().includes("claude") ? "Anthropic" : lbl.toLowerCase().includes("gpt") ? "OpenAI" : "Unknown",
                    quota,
                    resetTime
                  };
                }).filter((m) => !m.name.toLowerCase().includes("internal"));
                cacheExpiry = Date.now() + CACHE_TTL;
                console.log(`[RepoOrbit] Models fetched via Antigravity LS RPC (${proto})`);
                return modelCache || [];
              }
            }
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }
  }
  console.log("[RepoOrbit] Falling back to static model list");
  modelCache = [
    { id: "MODEL_PLACEHOLDER_M16", name: "Gemini 3.1 Pro (High)", vendor: "Google" },
    { id: "MODEL_PLACEHOLDER_M84", name: "Gemini 3 Flash", vendor: "Google" },
    { id: "MODEL_PLACEHOLDER_M35", name: "Claude Sonnet 4.6", vendor: "Anthropic" },
    { id: "MODEL_OPENAI_GPT_OSS_120B_MEDIUM", name: "GPT-OSS 120B", vendor: "OpenAI" }
  ];
  cacheExpiry = Date.now() + CACHE_TTL;
  return modelCache;
}
async function sendAntigravityChatDirect(query, modelId, repoContext, onUpdate) {
  const ls = await discoverLS();
  if (!ls) throw new Error("Language Server not discovered");
  const metadata = { ideName: "antigravity", extensionName: "repoorbit", ideVersion: vscode.version, locale: "en" };
  const port = ls.ports[0] || "34805";
  const workspaceUris = vscode.workspace.workspaceFolders?.map((f) => f.uri.toString()) || [];
  const sanitizedUris = workspaceUris.map((uri) => {
    try {
      const u = vscode.Uri.parse(uri);
      return u.scheme === "file" ? u.toString() : uri;
    } catch {
      return uri;
    }
  });
  const startBody = {
    metadata,
    source: 1,
    workspaceUris: sanitizedUris,
    customMetadata: repoContext ? { ...repoContext } : void 0
  };
  let startRes;
  let protocol = "https";
  try {
    startRes = await secureRPCRequest(`https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/StartCascade`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": ls.csrfToken
      },
      body: JSON.stringify(startBody)
    });
    if (!startRes.ok && startRes.status === 400) {
      const text = await startRes.text();
      if (text.includes("HTTP request to an HTTPS server")) protocol = "https";
      else if (text.includes("HTTPS request to an HTTP server")) protocol = "http";
    }
  } catch (err) {
    protocol = "http";
    startRes = await secureRPCRequest(`http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/StartCascade`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": ls.csrfToken
      },
      body: JSON.stringify(startBody)
    });
  }
  if (!startRes.ok) {
    const errorText = await startRes.text();
    throw new Error(`StartCascade failed: ${startRes.status} - ${errorText}`);
  }
  const { cascadeId } = await startRes.json();
  if (!cascadeId) throw new Error("No cascadeId returned");
  const sendRes = await secureRPCRequest(`${protocol}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "x-codeium-csrf-token": ls.csrfToken
    },
    body: JSON.stringify({
      metadata,
      cascadeId,
      items: [{ text: query }],
      clientType: 1,
      messageOrigin: 1,
      cascadeConfig: {
        plannerConfig: {
          conversational: { agenticMode: true },
          requestedModel: { model: modelId },
          toolConfig: {
            allowAllTools: true,
            autoRun: true
          }
        }
      }
    })
  });
  if (!sendRes.ok) {
    const errText = await sendRes.text();
    console.error(`[RepoOrbit] SendMessage failed with status ${sendRes.status}:`, errText);
    throw new Error(`SendMessage failed: ${sendRes.status} - ${errText}`);
  }
  console.log(`[RepoOrbit] Polling trajectory for cascade ${cascadeId}...`);
  let lastText = "";
  let pollCount = 0;
  while (true) {
    pollCount++;
    await new Promise((r) => setTimeout(r, 1e3));
    try {
      const trajRes = await secureRPCRequest(`${protocol}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "x-codeium-csrf-token": ls.csrfToken
        },
        body: JSON.stringify({ metadata, cascadeId })
      });
      if (trajRes.ok) {
        const data = await trajRes.json();
        const steps = data.trajectory?.steps || [];
        const status = data.status;
        if (!globalThis.approvedCallIds) {
          globalThis.approvedCallIds = /* @__PURE__ */ new Set();
        }
        const approvedIds = globalThis.approvedCallIds;
        for (const s of steps) {
          const callId = s.toolCall?.callId || s.plannerResponse?.callId;
          if (callId && !approvedIds.has(callId) && !s.toolCall?.response && !s.plannerResponse?.response) {
            console.log(`[RepoOrbit] AUTO-APPROVE: Advancing ${callId}`);
            approvedIds.add(callId);
            try {
              await secureRPCRequest(`${protocol}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/RespondToToolCall`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Connect-Protocol-Version": "1",
                  "x-codeium-csrf-token": ls.csrfToken
                },
                body: JSON.stringify({
                  metadata,
                  cascadeId,
                  callId,
                  response: { status: 1 }
                  // 1 = APPROVED
                })
              });
            } catch (approveErr) {
              console.error("[RepoOrbit] Auto-approval failed:", approveErr);
            }
          }
        }
        const plannerStep = [...steps].reverse().find((s) => s.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE");
        if (plannerStep) {
          const pr = plannerStep.plannerResponse;
          const text = pr?.modifiedResponse || pr?.response || pr?.content;
          const thinking = pr?.thinking;
          let combinedText = "";
          if (thinking) combinedText += `*Thinking...*

${thinking}

---

`;
          if (text) combinedText += text;
          if (combinedText && combinedText !== lastText) {
            lastText = combinedText;
            if (onUpdate) onUpdate({ text: lastText, steps });
          }
        }
        if ((status === "CASCADE_RUN_STATUS_IDLE" || status === 2) && lastText) {
          return lastText;
        }
        if (steps.some((s) => s.type === "CORTEX_STEP_TYPE_ERROR_MESSAGE")) {
          const errStep = steps.find((s) => s.type === "CORTEX_STEP_TYPE_ERROR_MESSAGE");
          const errorMsg = errStep?.errorMessage?.error?.userErrorMessage || errStep?.errorMessage?.error?.shortError || errStep?.errorMessage?.message || "Cascade encountered an error";
          throw new Error(errorMsg);
        }
      }
    } catch (pollErr) {
      console.warn(`[RepoOrbit] Poll attempt ${pollCount} result:`, pollErr.message);
      if (pollErr.message.includes("exhausted") || pollErr.message.includes("quota") || pollErr.message.includes("capacity")) {
        throw pollErr;
      }
    }
  }
  return lastText || "AI response timed out.";
}
async function handleWebviewMessage(webview, message, context) {
  console.log("[RepoOrbit] Message Received:", message.command);
  switch (message.command) {
    case "getModels":
      try {
        const models = await fetchModelsHybrid();
        webview.postMessage({ command: "setModels", models });
      } catch (err) {
        webview.postMessage({ command: "setModels", models: [], error: err.message });
      }
      return;
    case "chat":
      try {
        const { query, config, repoContext } = message;
        const modelId = config.model;
        console.log(`[RepoOrbit] AI Chat Request [Model: ${modelId}]:`, query);
        activeState.isLoading = true;
        activeState.config = config;
        try {
          const responseText = await sendAntigravityChatDirect(
            query,
            modelId,
            repoContext,
            (update) => {
              if (activeState.messages.length > 0) {
                const lastMsg = activeState.messages[activeState.messages.length - 1];
                if (lastMsg && lastMsg.role === "assistant") {
                  lastMsg.content = update.text;
                  lastMsg.steps = update.steps;
                } else {
                  activeState.messages.push({
                    role: "assistant",
                    content: update.text,
                    steps: update.steps
                  });
                }
              } else {
                activeState.messages.push({
                  role: "assistant",
                  content: update.text,
                  steps: update.steps
                });
              }
              currentWebview?.postMessage({
                command: "chatStream",
                text: update.text,
                steps: update.steps
              });
            }
          );
          if (activeState.messages.length > 0) {
            const lastMsg = activeState.messages[activeState.messages.length - 1];
            if (lastMsg && lastMsg.role === "assistant") {
              lastMsg.content = responseText;
            }
          }
          activeState.isLoading = false;
          webview.postMessage({ command: "chatResponse", text: responseText });
          return;
        } catch (lsErr) {
          console.warn("[RepoOrbit] Direct Cascade Flow failed:", lsErr.message);
          if (lsErr.message.includes("exhausted") || lsErr.message.includes("quota") || lsErr.message.includes("capacity")) {
            activeState.isLoading = false;
            webview.postMessage({ command: "chatError", text: lsErr.message });
            return;
          }
          console.log("[RepoOrbit] Trying fallbacks for non-quota error...");
        }
        if (vscode.lm) {
          try {
            const models = await vscode.lm.selectChatModels({ family: modelId.includes("gemini") ? "gemini" : void 0 });
            const model = models.find((m) => m.id === modelId) || models[0];
            if (model) {
              const request = [new vscode.LanguageModelUserMessage(query)];
              const lmResponse = await model.sendRequest(request, {}, new vscode.CancellationTokenSource().token);
              let fullText = "";
              for await (const fragment of lmResponse.text) {
                fullText += fragment;
              }
              if (activeState.messages.length > 0) {
                const lastMsg = activeState.messages[activeState.messages.length - 1];
                if (lastMsg && lastMsg.role === "assistant") {
                  lastMsg.content = fullText;
                }
              }
              activeState.isLoading = false;
              webview.postMessage({ command: "chatResponse", text: fullText });
              return;
            }
          } catch (lmErr) {
            console.warn("[RepoOrbit] vscode.lm fallback failed:", lmErr);
          }
        }
        const cmds = await vscode.commands.getCommands(true);
        const chatCmd = cmds.find((c) => c.includes("antigravity") && c.includes("chat")) || cmds.find((c) => c.includes("chat.focus"));
        if (chatCmd) {
          console.log("[RepoOrbit] Forwarding to discovered command:", chatCmd);
          await vscode.commands.executeCommand(chatCmd, query);
          const fallbackMsg = "\u{1F680} Direct API call failed. Prompt forwarded to the native Antigravity Chat panel.";
          if (activeState.messages.length > 0) {
            const lastMsg = activeState.messages[activeState.messages.length - 1];
            if (lastMsg && lastMsg.role === "assistant") {
              lastMsg.content = fallbackMsg;
            }
          }
          activeState.isLoading = false;
          webview.postMessage({
            command: "chatResponse",
            text: fallbackMsg
          });
        } else {
          throw new Error("All chat providers failed and no native chat command found.");
        }
      } catch (err) {
        activeState.isLoading = false;
        webview.postMessage({ command: "setError", text: `Chat Error: ${err.message}` });
      }
      return;
    case "analyzeRepo":
      try {
        const { owner, repo } = parseRepoInput((message.url || "").trim());
        const storedToken = context.globalState.get("github_token");
        const repoData = await getRepoData(owner, repo, storedToken);
        webview.postMessage({
          command: "setRepoData",
          treeRoot: { name: repoData.metadata.name, path: "", type: "folder", children: repoData.tree },
          fullRepoData: repoData
        });
      } catch (err) {
        webview.postMessage({ command: "setError", text: err.message });
      }
      return;
    case "getFileContent":
      try {
        const { owner, repo } = parseRepoInput((message.url || "").trim());
        const storedToken = context.globalState.get("github_token");
        const [content, commits] = await Promise.all([
          fetchFileContent(owner, repo, message.path, message.branch || "main", storedToken),
          fetchCommitsForPath(owner, repo, message.path, storedToken)
        ]);
        webview.postMessage({
          command: "fileContentResponse",
          path: message.path,
          content,
          analysis: content ? analyzeFile(message.path, content) : null,
          latestCommit: commits?.[0] || null,
          history: commits
        });
      } catch (err) {
        webview.postMessage({ command: "fileContentResponse", path: message.path, error: err.message });
      }
      return;
    case "cloneRepo":
      try {
        const { url, path: targetPath } = message;
        let fullPath = targetPath;
        if (!path2.isAbsolute(targetPath)) {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (workspaceFolder) {
            fullPath = path2.join(workspaceFolder, targetPath);
          } else {
            fullPath = path2.join(process.cwd(), targetPath);
          }
        }
        console.log(`[RepoOrbit] Cloning ${url} into ${fullPath}...`);
        let cloneDest = fullPath;
        const parentDir = path2.dirname(cloneDest);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        (0, import_child_process.execSync)(`git clone ${url} "${cloneDest}"`, { stdio: "inherit" });
        try {
          const agentsRulesDir = path2.join(cloneDest, ".agents", "rules");
          if (!fs.existsSync(agentsRulesDir)) {
            fs.mkdirSync(agentsRulesDir, { recursive: true });
          }
          const masterPath = path2.join(agentsRulesDir, "MASTER.md");
          if (!fs.existsSync(masterPath)) {
            fs.writeFileSync(masterPath, MASTER_MD_CONTENT);
          }
          const repoorbitDir = path2.join(cloneDest, ".repoorbit");
          if (!fs.existsSync(repoorbitDir)) {
            fs.mkdirSync(repoorbitDir, { recursive: true });
          }
          const queriesPath = path2.join(repoorbitDir, "queries.md");
          if (!fs.existsSync(queriesPath)) {
            fs.writeFileSync(queriesPath, DEFAULT_QUERIES_CONTENT);
          }
        } catch (bootstrapErr) {
          console.error("[RepoOrbit] Failed to bootstrap rules/queries:", bootstrapErr);
        }
        vscode.window.showInformationMessage(`RepoOrbit: Cloned ${url} successfully!`);
        webview.postMessage({ command: "cloneSuccess", path: cloneDest });
      } catch (err) {
        console.error("[RepoOrbit] Clone failed:", err);
        webview.postMessage({ command: "setError", text: `Clone Failed: ${err.message}` });
      }
      return;
    case "readQueriesFile":
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) {
          webview.postMessage({ command: "queriesFileResponse", exists: false, queries: [] });
          return;
        }
        const filePath = path2.join(workspaceFolder, ".repoorbit", "queries.md");
        if (!fs.existsSync(filePath)) {
          webview.postMessage({ command: "queriesFileResponse", exists: false, queries: [] });
          return;
        }
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).filter((line) => !line.startsWith("#")).map((line) => line.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "")).filter((line) => line.length > 0);
        webview.postMessage({ command: "queriesFileResponse", exists: true, queries: lines });
      } catch (err) {
        webview.postMessage({ command: "queriesFileResponse", exists: false, queries: [] });
      }
      return;
    case "createQueriesFile":
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) return;
        const repoorbitDir = path2.join(workspaceFolder, ".repoorbit");
        if (!fs.existsSync(repoorbitDir)) {
          fs.mkdirSync(repoorbitDir, { recursive: true });
        }
        const queriesPath = path2.join(repoorbitDir, "queries.md");
        if (!fs.existsSync(queriesPath)) {
          fs.writeFileSync(queriesPath, DEFAULT_QUERIES_CONTENT);
        }
        const content = fs.readFileSync(queriesPath, "utf8");
        const lines = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).filter((line) => !line.startsWith("#")).map((line) => line.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "")).filter((line) => line.length > 0);
        webview.postMessage({ command: "queriesFileResponse", exists: true, queries: lines });
      } catch (err) {
        console.error(err);
      }
      return;
    case "checkWorkspaceStatus":
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) {
          webview.postMessage({ command: "workspaceStatus", isEmpty: true });
          return;
        }
        const files = fs.readdirSync(workspaceFolder);
        const meaningfulFiles = files.filter((f) => ![".git", ".DS_Store", ".vscode", ".antigravity"].includes(f));
        webview.postMessage({ command: "workspaceStatus", isEmpty: meaningfulFiles.length === 0 });
      } catch (err) {
        webview.postMessage({ command: "workspaceStatus", isEmpty: false });
      }
      return;
    case "saveToken":
      await context.globalState.update("github_token", message.token);
      vscode.window.showInformationMessage("RepoOrbit: Token saved!");
      return;
    case "syncState":
      if (message.state) {
        activeState = { ...activeState, ...message.state };
      }
      return;
    case "getStoredState":
      webview.postMessage({ command: "restoreState", state: activeState });
      return;
    case "clearChat":
      activeState = {
        messages: [],
        isPlaying: false,
        currentQueryIndex: -1,
        retryCount: 0,
        isLoading: false,
        repoUrl: activeState.repoUrl,
        forkOwner: "",
        upstreamOwner: "",
        upstreamRepo: "",
        branchName: "",
        defaultBranch: "",
        config: activeState.config
      };
      return;
  }
}
async function activate(context) {
  console.log("[RepoOrbit] Extension activated");
  const isFileGitIgnoredCmd = vscode.commands.registerCommand("antigravity.isFileGitIgnored", async (uri) => {
    try {
      const fsPath = uri.fsPath;
      const repoPath = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
      if (!repoPath) return false;
      const relativePath = path2.relative(repoPath, fsPath);
      const output = (0, import_child_process.execSync)(`git check-ignore "${relativePath}"`, { cwd: repoPath, encoding: "utf8" }).trim();
      return !!output;
    } catch {
      return false;
    }
  });
  context.subscriptions.push(isFileGitIgnoredCmd);
  let token = context.globalState.get("github_token");
  if (!token) {
  }
  const updateTokenCmd = vscode.commands.registerCommand("repoorbit.updateToken", async () => {
    const newToken = await vscode.window.showInputBox({
      prompt: "Enter new GitHub Personal Access Token",
      placeHolder: "ghp_...",
      password: true
    });
    if (newToken) {
      await context.globalState.update("github_token", newToken);
      vscode.window.showInformationMessage("RepoOrbit: Token updated!");
    }
  });
  const openWorkspaceCmd = vscode.commands.registerCommand("repoorbit.openWorkspace", () => {
    vscode.commands.executeCommand("workbench.view.extension.repoorbit-sidebar-container");
    vscode.commands.executeCommand("repoorbit.sidebarView.focus");
  });
  const sidebarProvider = new SidebarWebviewViewProvider(
    context.extensionUri,
    context.extensionMode === vscode.ExtensionMode.Development,
    context
  );
  const sidebarViewReg = vscode.window.registerWebviewViewProvider(
    SidebarWebviewViewProvider.viewType,
    sidebarProvider
  );
  context.subscriptions.push(updateTokenCmd, openWorkspaceCmd, sidebarViewReg);
}
var SidebarWebviewViewProvider = class {
  constructor(_extensionUri, _isDev, _context) {
    this._extensionUri = _extensionUri;
    this._isDev = _isDev;
    this._context = _context;
  }
  static {
    this.viewType = "repoorbit.sidebarView";
  }
  resolveWebviewView(webviewView, context, _token) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path2.join(this._extensionUri.fsPath, "dist-webview"))]
    };
    webviewView.webview.html = getWebviewContent(
      webviewView.webview,
      this._extensionUri,
      this._isDev
    );
    currentWebview = webviewView.webview;
    webviewView.webview.onDidReceiveMessage(async (message) => {
      await handleWebviewMessage(webviewView.webview, message, this._context);
    });
    webviewView.onDidDispose(() => {
      if (currentWebview === webviewView.webview) {
        currentWebview = void 0;
      }
    });
  }
};
function getWebviewContent(webview, extensionUri, isDev) {
  if (isDev) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: blob: data:; style-src ${webview.cspSource} 'unsafe-inline' http://localhost:5173; script-src 'unsafe-inline' 'unsafe-eval' http://localhost:5173; connect-src http://localhost:5173 ws://localhost:5173 http://127.0.0.1:*;">
  <title>RepoOrbit Dev</title>
  <script type="module">
    import { injectIntoGlobalHook } from "http://localhost:5173/@react-refresh";
    injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
  </script>
  <script type="module" src="http://localhost:5173/@vite/client"></script>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;color:white;">
  <div id="root"></div>
  <script type="module" src="http://localhost:5173/src/main.tsx"></script>
</body>
</html>`;
  }
  const distPath = vscode.Uri.joinPath(extensionUri, "dist-webview");
  const indexHtmlPath = path2.join(distPath.fsPath, "index.html");
  if (!fs.existsSync(indexHtmlPath)) return "<h1>Build missing. Run `npm run ext:build-ui`</h1>";
  let html = fs.readFileSync(indexHtmlPath, "utf8");
  const assetUri = webview.asWebviewUri(distPath);
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: blob: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-eval' 'unsafe-inline'; connect-src https: http: ws: wss:;">`;
  html = html.replace("<head>", `<head>
    ${csp}`);
  html = html.replace(/(href|src)="\/assets\//g, `$1="${assetUri}/assets/`).replace(/(href|src)="\//g, `$1="${assetUri}/`);
  return html;
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
