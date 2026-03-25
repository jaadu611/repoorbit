import { RepoContext, RepoTreeEntry, CommitDetail } from "./types";

function getHeaders() {
  let token = process.env.GITHUB_TOKEN || process.env.NEXT_PUBLIC_GITHUB_TOKEN;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "RepoOrbit",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (token) {
    token = token.trim();
    if (token !== "" && token !== "undefined" && token !== "null") {
      const cleanToken = token.replace(/^["']|["']$/g, "");
      headers["Authorization"] = `Bearer ${cleanToken}`;
    }
  }

  return headers;
}

const withCache = { next: { revalidate: 3600 } } as const;
const noCache = { cache: "no-store" } as const;

function safeJson(res: Response | null) {
  return res?.ok ? res.json() : Promise.resolve(null);
}

export function parseRepoInput(input: string): { owner: string; repo: string } {
  const cleaned = input
    .trim()
    .replace(/\/$/, "")
    .replace(/\.git$/, "");

  const urlMatch = cleaned.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (urlMatch) return { owner: urlMatch[1].trim(), repo: urlMatch[2].trim() };

  const parts = cleaned
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };

  throw new Error(`Invalid repo input: "${input}"`);
}

function buildExtFreq(tree: any[]): Record<string, number> {
  const freq: Record<string, number> = {};
  for (const item of tree) {
    if (item.type !== "blob") continue;
    const name: string = item.path.split("/").pop() ?? "";
    if (!name.includes(".")) continue;
    const ext = name.split(".").pop()!.toLowerCase();
    freq[ext] = (freq[ext] ?? 0) + 1;
  }
  return freq;
}

function buildStackFlags(paths: string[]) {
  const s = paths.map((p) => p.toLowerCase());
  const has = (test: (p: string) => boolean) => s.some(test);

  return {
    hasLockfile: has(
      (p) =>
        p === "package-lock.json" ||
        p === "yarn.lock" ||
        p === "pnpm-lock.yaml",
    ),
    hasDocker: has(
      (p) =>
        p.includes("dockerfile") ||
        p === "docker-compose.yml" ||
        p === "docker-compose.yaml",
    ),
    hasTailwind: has((p) => p.includes("tailwind.config")),
    hasNextjs: has((p) => p.includes("next.config")),
    hasVite: has((p) => p.includes("vite.config")),
    hasWebpack: has((p) => p.includes("webpack.config")),
    hasPrisma: has((p) => p.endsWith("schema.prisma")),
    hasEnvFile: has(
      (p) => p === ".env" || p === ".env.example" || p === ".env.local",
    ),
    hasGitActions: has((p) => p.startsWith(".github/workflows")),
    hasTests: has((p) => /test|spec|__tests__|jest|vitest/.test(p)),
    hasReadme: has((p) => p === "readme.md"),
    architecture: has((p) => p.includes("next.config"))
      ? "Next.js"
      : has((p) => p.includes("vite.config"))
        ? "Vite"
        : has((p) => p === "package-lock.json" || p === "yarn.lock")
          ? "Node.js"
          : "General",
  };
}

async function fetchCommitsForAuthor(
  owner: string,
  repo: string,
  login: string,
): Promise<CommitDetail[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?author=${login}&per_page=15&page=1`;

  try {
    const res = await fetch(url, { headers: getHeaders(), ...withCache });
    if (!res.ok) return [];

    const data = await res.json().catch(() => null);
    if (!Array.isArray(data)) return [];

    return data.map((c: any) => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: c.commit?.message ?? "",
      author: c.commit?.author?.name ?? login,
      authorEmail: c.commit?.author?.email ?? "",
      date: c.commit?.author?.date ?? "",
      htmlUrl: c.html_url ?? "",
      avatarUrl: c.author?.avatar_url ?? null,
      profileUrl: c.author?.html_url ?? null,
    }));
  } catch {
    return [];
  }
}

export async function fetchCommitsForPath(
  owner: string,
  repo: string,
  path: string,
): Promise<CommitDetail[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&per_page=15`;

  try {
    const res = await fetch(url, { headers: getHeaders(), ...withCache });
    if (!res.ok) return [];

    const data = await res.json().catch(() => null);
    if (!Array.isArray(data)) return [];

    return data.map((c: any) => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: c.commit?.message ?? "",
      author: c.commit?.author?.name ?? c.author?.login ?? "Unknown",
      authorEmail: c.commit?.author?.email ?? "",
      date: c.commit?.author?.date ?? "",
      htmlUrl: c.html_url ?? "",
      avatarUrl: c.author?.avatar_url ?? null,
      profileUrl: c.author?.html_url ?? null,
    }));
  } catch {
    return [];
  }
}

export async function fetchFileContent(owner: string, repo: string, path: string, ref = "main"): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`;
  try {
    const res = await fetch(url, {
      headers: { ...getHeaders(), Accept: "application/vnd.github.raw" },
      ...noCache,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export function parseImports(content: string): string[] {
  const results: string[] = [];
  const importRegex = /(?:import|from)\s+['"]([^'"]+)['"]/g;
  const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(content)) !== null) results.push(m[1]);
  while ((m = requireRegex.exec(content)) !== null) results.push(m[1]);
  return results.filter((i) => i.startsWith(".") || i.startsWith("/"));
}

export function analyzeFile(filename: string, content: string) {
  const lines = content.split("\n");
  const functionCount = (content.match(/\bfunction\b|\b=>\s*[{(]/g) ?? []).length;
  const classCount = (content.match(/\bclass\s+\w+/g) ?? []).length;
  const isReact = /import\s+.*React|from\s+['"]react['"]/.test(content);
  const isTest = /\.(test|spec)\.[a-z]+$/.test(filename) || /describe\(|it\(|test\(/.test(content);
  const isConfig = /config|\.env|rc\b/.test(filename.toLowerCase());
  const isTypeScript = /\.(ts|tsx)$/.test(filename);
  const hasJsx = /\.(tsx|jsx)$/.test(filename) || /<[A-Z][A-Za-z0-9]*\s*\/?>/.test(content);

  const exportMatches = content.matchAll(
    /export\s+(?:default\s+)?(?:async\s+)?(?:(function|class|type|interface|enum)\s+(\w+)|const\s+(\w+)\s*=)/g,
  );
  const exportsLine = [...exportMatches].map((m) => (m[2] ?? m[3] ?? "").trim()).filter(Boolean);

  const todoComments = (content.match(/\/\/.*TODO:?.*$|#.*TODO:?.*$/gm) ?? []).map((t: string) => t.replace(/^\s*\/\/\s*|^\s*#\s*/, ""));

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
    hasJsx,
    lineCount: lines.length,
    codeLines,
    emptyLines,
    commentLines,
    charCount: content.length,
    logicType: isTest ? "Test" : isConfig ? "Config" : isReact ? "React Logic" : "Core Logic",
  };
}

export const getRepoData = async (owner: string, repo: string) => {
  const url = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = getHeaders();

  const repoRes = await fetch(url, { headers, ...withCache });

  if (!repoRes.ok) {
    const errorBody = await repoRes.json().catch(() => ({}));
    console.error(`Repo fetch failed for ${owner}/${repo}:`, {
      status: repoRes.status,
      errorBody,
      url,
    });
    const reason =
      repoRes.status === 403
        ? "Rate limited — add a GITHUB_TOKEN to your .env"
        : repoRes.status === 404
          ? "Repo not found — check the owner/repo name"
          : `GitHub API error (${repoRes.status})`;
    throw new Error(reason);
  }

  const repoData = await repoRes.json();
  const defaultBranch: string = repoData.default_branch;

  const [
    treeRes,
    readmeRes,
    commitsRes,
    contributorsRes,
    languagesRes,
    releasesRes,
    branchesRes,
    issuesRes,
    pullsRes,
  ] = await Promise.allSettled([
    fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`,
      { headers: getHeaders(), ...noCache },
    ),
    fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
      headers: { ...getHeaders(), Accept: "application/vnd.github.raw" },
      ...withCache,
    }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=30`, {
      headers: getHeaders(),
      ...withCache,
    }),
    fetch(
      `https://api.github.com/repos/${owner}/${repo}/contributors?per_page=20`,
      { headers: getHeaders(), ...withCache },
    ),
    fetch(`https://api.github.com/repos/${owner}/${repo}/languages`, {
      headers: getHeaders(),
      ...withCache,
    }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=5`, {
      headers: getHeaders(),
      ...withCache,
    }),
    fetch(
      `https://api.github.com/repos/${owner}/${repo}/branches?per_page=30`,
      { headers: getHeaders(), ...withCache },
    ),
    // Exclude PRs from issues — GitHub returns both from /issues by default
    fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=30&pulls=false`,
      { headers: getHeaders(), ...withCache },
    ),
    fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&per_page=30`,
      { headers: getHeaders(), ...withCache },
    ),
  ]);

  const treeValue = treeRes.status === "fulfilled" ? treeRes.value : null;
  const readmeValue = readmeRes.status === "fulfilled" ? readmeRes.value : null;

  if (!treeValue?.ok) {
    const status = treeValue?.status;
    const errorBody = await treeValue?.json().catch(() => ({}));
    console.error("Tree fetch failed:", { status, errorBody });
    const reason =
      status === 403
        ? `GitHub API error: ${errorBody.message || "Rate limited or tree too large"} — add a GITHUB_TOKEN to your .env`
        : status === 404
          ? "Repo tree not found"
          : `Tree fetch failed (${status ?? "network error"})`;
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
    pullsData,
  ] = await Promise.all([
    treeValue.json(),
    safeJson(commitsRes.status === "fulfilled" ? commitsRes.value : null),
    safeJson(
      contributorsRes.status === "fulfilled" ? contributorsRes.value : null,
    ),
    safeJson(languagesRes.status === "fulfilled" ? languagesRes.value : null),
    safeJson(releasesRes.status === "fulfilled" ? releasesRes.value : null),
    safeJson(branchesRes.status === "fulfilled" ? branchesRes.value : null),
    safeJson(issuesRes.status === "fulfilled" ? issuesRes.value : null),
    safeJson(pullsRes.status === "fulfilled" ? pullsRes.value : null),
  ]);

  const readmeText: string = readmeValue?.ok
    ? await readmeValue.text()
    : "No README available.";

  // ── Full commit history per contributor ────────────────────────────────────
  const contributorLogins: string[] = Array.isArray(contributorsData)
    ? contributorsData.map((c: any) => c.login as string)
    : [];

  const commitsByAuthorEntries = await Promise.all(
    contributorLogins.map(async (login) => {
      const commits = await fetchCommitsForAuthor(owner, repo, login);
      return [login, commits] as [string, CommitDetail[]];
    }),
  );

  const commitsByAuthor: Record<string, CommitDetail[]> = Object.fromEntries(
    commitsByAuthorEntries,
  );

  const totalCommitsFetched = Object.values(commitsByAuthor).reduce(
    (sum, commits) => sum + commits.length,
    0,
  );

  // ── Build tree ─────────────────────────────────────────────────────────────
  const rawTree: any[] = treeData.tree ?? [];
  const allPaths = rawTree.map((n: any) => n.path as string);

  const flatTree: RepoTreeEntry[] = rawTree.map((n: any) => {
    const namePart = n.path.split("/").pop() ?? n.path;
    const ext = namePart.includes(".")
      ? namePart.split(".").pop()!.toLowerCase()
      : "";
    return {
      path: n.path,
      name: namePart,
      type: n.type === "tree" ? "folder" : "file",
      ext,
      size: n.size ?? 0,
      depth: n.path.split("/").length,
      sha: n.sha,
    };
  });

  const allFiles = flatTree.filter((e) => e.type === "file");
  const allFolders = flatTree.filter((e) => e.type === "folder");
  const rootItems = flatTree.filter((e) => e.depth === 1);
  const extFreq = buildExtFreq(rawTree);
  const stack = buildStackFlags(allPaths);

  const langMap: Record<string, number> = languagesData ?? {};
  const langTotal = Object.values(langMap).reduce(
    (a: number, b: number) => a + b,
    0,
  );
  const languages = Object.entries(langMap)
    .map(([lang, bytes]) => ({
      lang,
      bytes,
      pct: langTotal > 0 ? Math.round((bytes / langTotal) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const latestCommitRaw = Array.isArray(commitsData) ? commitsData[0] : null;
  const releases = Array.isArray(releasesData) ? releasesData : [];

  // ── Shape issues (filter out any PRs GitHub sneaks in) ─────────────────────
  const issues = Array.isArray(issuesData)
    ? issuesData
        .filter((i: any) => !i.pull_request)
        .map((i: any) => ({
          number: i.number,
          title: i.title,
          state: i.state as "open" | "closed",
          author: i.user?.login ?? null,
          createdAt: i.created_at,
          updatedAt: i.updated_at,
          closedAt: i.closed_at ?? null,
          labels: (i.labels ?? []).map((l: any) => l.name as string),
          comments: i.comments,
          htmlUrl: i.html_url,
          body: i.body ? (i.body as string).slice(0, 500) : null,
        }))
    : [];

  // ── Shape pull requests ────────────────────────────────────────────────────
  const pulls = Array.isArray(pullsData)
    ? pullsData.map((p: any) => ({
        number: p.number,
        title: p.title,
        state: p.state as "open" | "closed",
        merged: p.merged_at !== null,
        author: p.user?.login ?? null,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        mergedAt: p.merged_at ?? null,
        closedAt: p.closed_at ?? null,
        baseBranch: p.base?.ref ?? null,
        headBranch: p.head?.ref ?? null,
        labels: (p.labels ?? []).map((l: any) => l.name as string),
        comments: p.comments,
        htmlUrl: p.html_url,
        body: p.body ? (p.body as string).slice(0, 500) : null,
      }))
    : [];

  const repoContext: RepoContext = {
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
      license:
        repoData.license?.spdx_id ?? repoData.license?.name ?? "No License",
      defaultBranch,
      visibility: repoData.visibility,
    },

    github: {
      description: repoData.description ?? null,
      homepage: repoData.homepage ?? null,
      topics: repoData.topics ?? [],
      createdAt: repoData.created_at,
      updatedAt: repoData.updated_at,
      pushedAt: repoData.pushed_at,
      htmlUrl: repoData.html_url,
    },

    latestCommit: latestCommitRaw
      ? {
          sha: latestCommitRaw.sha,
          shortSha: latestCommitRaw.sha.slice(0, 7),
          message: latestCommitRaw.commit.message,
          author: latestCommitRaw.commit.author.name,
          authorEmail: latestCommitRaw.commit.author.email,
          date: latestCommitRaw.commit.author.date,
          htmlUrl: latestCommitRaw.html_url,
          avatarUrl: latestCommitRaw.author?.avatar_url ?? null,
          profileUrl: latestCommitRaw.author?.html_url ?? null,
        }
      : null,

    recentCommits: Array.isArray(commitsData)
      ? commitsData.map((c: any) => ({
          sha: c.sha,
          shortSha: c.sha.slice(0, 7),
          message: c.commit.message,
          author: c.commit.author.name,
          date: c.commit.author.date,
          htmlUrl: c.html_url,
        }))
      : [],

    commitsByAuthor,
    totalCommitsFetched,

    contributors: Array.isArray(contributorsData)
      ? contributorsData.map((c: any) => ({
          login: c.login,
          avatarUrl: c.avatar_url,
          profileUrl: c.html_url,
          contributions: c.contributions,
        }))
      : [],

    languages,

    releases: releases.map((r: any) => ({
      tagName: r.tag_name,
      name: r.name,
      publishedAt: r.published_at,
      htmlUrl: r.html_url,
      prerelease: r.prerelease,
      draft: r.draft,
    })),

    latestRelease: releases[0]
      ? {
          tagName: releases[0].tag_name,
          name: releases[0].name,
          publishedAt: releases[0].published_at,
          htmlUrl: releases[0].html_url,
          prerelease: releases[0].prerelease,
          draft: releases[0].draft,
        }
      : null,

    branches: Array.isArray(branchesData)
      ? branchesData.map((b: any) => ({
          name: b.name,
          protected: b.protected,
        }))
      : [],

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
      dominantExt:
        Object.entries(extFreq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    },

    stack: {
      ...stack,
      entryPoints: rootItems
        .filter((e) => /^(index|main|app|page)\./i.test(e.name))
        .map((e) => e.name),
    },
  };

  return {
    tree: rawTree,
    readme: readmeText,
    metadata: repoContext.meta,
    repoContext,
    filesMetadata: [],
    importGraph: {},
  };
};
