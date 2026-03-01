import { useSelectionStore } from "@/lib/store";
import { RepoContext, RepoTreeEntry } from "./types";

const token = process.env.GITHUB_TOKEN;

const baseHeaders = {
  Accept: "application/vnd.github+json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

// helpers

function safeJson(res: Response) {
  return res.ok ? res.json() : Promise.resolve(null);
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

  const hasLockfile = has(
    (p) =>
      p === "package-lock.json" || p === "yarn.lock" || p === "pnpm-lock.yaml",
  );
  const hasDocker = has(
    (p) =>
      p.includes("dockerfile") ||
      p === "docker-compose.yml" ||
      p === "docker-compose.yaml",
  );
  const hasTailwind = has((p) => p.includes("tailwind.config"));
  const hasNextjs = has((p) => p.includes("next.config"));
  const hasVite = has((p) => p.includes("vite.config"));
  const hasWebpack = has((p) => p.includes("webpack.config"));
  const hasPrisma = has((p) => p.endsWith("schema.prisma"));
  const hasEnvFile = has(
    (p) => p === ".env" || p === ".env.example" || p === ".env.local",
  );
  const hasGitActions = has((p) => p.startsWith(".github/workflows"));
  const hasTests = has((p) => /test|spec|__tests__|jest|vitest/.test(p));
  const hasReadme = has((p) => p === "readme.md");

  return {
    hasLockfile,
    hasDocker,
    hasTailwind,
    hasNextjs,
    hasVite,
    hasWebpack,
    hasPrisma,
    hasEnvFile,
    hasGitActions,
    hasTests,
    hasReadme,
    architecture: hasNextjs
      ? "Next.js"
      : hasVite
        ? "Vite"
        : hasLockfile
          ? "Node.js"
          : "General",
  };
}

// main function

export const getRepoData = async (owner: string, repo: string) => {
  const cache = { next: { revalidate: 3600 } } as const;

  // ── 1. Repo info first — we need default_branch before the tree fetch ──
  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: baseHeaders,
    ...cache,
  });

  if (!repoRes.ok) {
    throw new Error(`GitHub API Error: repo info failed (${repoRes.status})`);
  }

  const repoData = await repoRes.json();
  const defaultBranch: string = repoData.default_branch;

  // get some data here
  const [
    treeRes,
    readmeRes,
    commitsRes,
    contributorsRes,
    languagesRes,
    releasesRes,
    branchesRes,
  ] = await Promise.allSettled([
    fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`,
      { headers: baseHeaders, ...cache },
    ),
    fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
      headers: { ...baseHeaders, Accept: "application/vnd.github.raw" },
      ...cache,
    }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`, {
      headers: baseHeaders,
      ...cache,
    }),
    fetch(
      `https://api.github.com/repos/${owner}/${repo}/contributors?per_page=10`,
      { headers: baseHeaders, ...cache },
    ),
    fetch(`https://api.github.com/repos/${owner}/${repo}/languages`, {
      headers: baseHeaders,
      ...cache,
    }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=1`, {
      headers: baseHeaders,
      ...cache,
    }),
    fetch(
      `https://api.github.com/repos/${owner}/${repo}/branches?per_page=20`,
      { headers: baseHeaders, ...cache },
    ),
  ]);

  const treeValue = treeRes.status === "fulfilled" ? treeRes.value : null;
  const readmeValue = readmeRes.status === "fulfilled" ? readmeRes.value : null;
  const commitsValue =
    commitsRes.status === "fulfilled" ? commitsRes.value : null;
  const contributorsValue =
    contributorsRes.status === "fulfilled" ? contributorsRes.value : null;
  const languagesValue =
    languagesRes.status === "fulfilled" ? languagesRes.value : null;
  const releasesValue =
    releasesRes.status === "fulfilled" ? releasesRes.value : null;
  const branchesValue =
    branchesRes.status === "fulfilled" ? branchesRes.value : null;

  if (!treeValue?.ok) {
    throw new Error(
      `GitHub API Error: tree fetch failed (${treeValue?.status ?? "network error"})`,
    );
  }

  // get some more data here
  const [
    treeData,
    commitsData,
    contributorsData,
    languagesData,
    releasesData,
    branchesData,
  ] = await Promise.all([
    treeValue.json(),
    safeJson(commitsValue!),
    safeJson(contributorsValue!),
    safeJson(languagesValue!),
    safeJson(releasesValue!),
    safeJson(branchesValue!),
  ]);

  const readmeText: string = readmeValue?.ok
    ? await readmeValue.text()
    : "No README available for this repository.";
  const rawTree: any[] = treeData.tree ?? [];
  const allPaths = rawTree.map((n: any) => n.path as string);

  const flatTree: RepoTreeEntry[] = rawTree.map((n: any) => {
    const namePart = n.path.split("/").pop() ?? n.path;
    const ext = namePart.includes(".")
      ? namePart.split(".").pop()!.toLowerCase()
      : "";
    const depth = n.path.split("/").length;
    return {
      path: n.path,
      name: namePart,
      type: n.type === "tree" ? "folder" : "file",
      ext,
      size: n.size ?? 0,
      depth,
    };
  });

  const allFiles = flatTree.filter((e) => e.type === "file");
  const allFolders = flatTree.filter((e) => e.type === "folder");
  const rootItems = flatTree.filter((e) => e.depth === 1);

  const extFreq = buildExtFreq(rawTree);
  const dominantExt =
    Object.entries(extFreq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const stack = buildStackFlags(allPaths);

  const entryPoints = rootItems
    .filter((e) => /^(index|main|app|page)\./i.test(e.name))
    .map((e) => e.name);

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
  const latestRelease = Array.isArray(releasesData)
    ? (releasesData[0] ?? null)
    : null;

  // the final context
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
      watchers: repoData.watchers_count,
      networkCount: repoData.network_count ?? 0,
      subscribersCount: repoData.subscribers_count ?? 0,
      hasWiki: repoData.has_wiki,
      hasPages: repoData.has_pages,
      hasDiscussions: repoData.has_discussions ?? false,
      archived: repoData.archived,
      disabled: repoData.disabled,
      fork: repoData.fork,
      htmlUrl: repoData.html_url,
      cloneUrl: repoData.clone_url,
      sshUrl: repoData.ssh_url,
      ownerType: repoData.owner?.type ?? null,
      ownerProfileUrl: repoData.owner?.html_url ?? null,
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

    contributors: Array.isArray(contributorsData)
      ? contributorsData.map((c: any) => ({
          login: c.login,
          avatarUrl: c.avatar_url,
          profileUrl: c.html_url,
          contributions: c.contributions,
        }))
      : [],

    languages,

    latestRelease: latestRelease
      ? {
          tagName: latestRelease.tag_name,
          name: latestRelease.name,
          publishedAt: latestRelease.published_at,
          htmlUrl: latestRelease.html_url,
          prerelease: latestRelease.prerelease,
          draft: latestRelease.draft,
        }
      : null,

    branches: Array.isArray(branchesData)
      ? branchesData.map((b: any) => ({
          name: b.name,
          protected: b.protected,
        }))
      : [],

    tree: flatTree,

    stats: {
      totalFiles: allFiles.length,
      totalFolders: allFolders.length,
      totalSize: allFiles.reduce((acc, e) => acc + e.size, 0),
      maxDepth: flatTree.reduce((acc, e) => Math.max(acc, e.depth), 0),
      rootItemCount: rootItems.length,
      extFrequency: extFreq,
      dominantExt,
    },

    stack: {
      ...stack,
      entryPoints,
    },
  };

  // We don't update the client store from the server fetch directly anymore
  // to prevent shared state issues and hydration mismatches.
  // useSelectionStore.getState().setRepoContext(repoContext);

  return {
    tree: rawTree,
    readme: readmeText,
    metadata: repoContext.meta,
    repoContext,
  };
};
