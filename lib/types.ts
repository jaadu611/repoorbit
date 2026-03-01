export interface RepoTreeEntry {
  path: string;
  name: string;
  type: "folder" | "file";
  ext: string;
  size: number;
  depth: number;
}

export interface RepoMeta {
  name: string;
  fullName: string;
  owner: string;
  avatar: string;
  stars: number;
  forks: number;
  openIssues: number;
  size: number;
  pushedAt: string;
  language: string;
  license: string;
  defaultBranch: string;
  visibility: string;
}

export interface RepoContext {
  meta: RepoMeta;
  github: {
    description: string | null;
    homepage: string | null;
    topics: string[];
    createdAt: string;
    updatedAt: string;
    pushedAt: string;
    watchers: number;
    networkCount: number;
    subscribersCount: number;
    hasWiki: boolean;
    hasPages: boolean;
    hasDiscussions: boolean;
    archived: boolean;
    disabled: boolean;
    fork: boolean;
    htmlUrl: string;
    cloneUrl: string;
    sshUrl: string;
    ownerType: string | null;
    ownerProfileUrl: string | null;
  } | null;
  latestCommit: {
    sha: string;
    message: string;
    author: string;
    authorEmail: string;
    date: string;
    htmlUrl: string;
    avatarUrl: string | null;
    profileUrl: string | null;
    shortSha: string;
  } | null;
  contributors: {
    login: string;
    avatarUrl: string;
    profileUrl: string;
    contributions: number;
  }[];
  languages: {
    lang: string;
    bytes: number;
    pct: number;
  }[];
  latestRelease: {
    tagName: string;
    name: string;
    publishedAt: string;
    htmlUrl: string;
    prerelease: boolean;
    draft: boolean;
  } | null;
  branches: {
    name: string;
    protected: boolean;
  }[];
  tree: RepoTreeEntry[];
  stats: {
    totalFiles: number;
    totalFolders: number;
    totalSize: number;
    maxDepth: number;
    rootItemCount: number;
    extFrequency: Record<string, number>;
    dominantExt: string | null;
  };
  stack: {
    hasLockfile: boolean;
    hasDocker: boolean;
    hasTailwind: boolean;
    hasNextjs: boolean;
    hasVite: boolean;
    hasWebpack: boolean;
    hasPrisma: boolean;
    hasEnvFile: boolean;
    hasGitActions: boolean;
    hasTests: boolean;
    hasReadme: boolean;
    entryPoints: string[];
    architecture: string;
  };
}

export interface FolderContext {
  id: string;
  name: string;
  path: string;
  depth: number;
  size: number;
  branchWeight: number;
  isLarge: boolean;
  children: {
    name: string;
    path: string;
    type: string;
    size: number;
    sha: string;
    htmlUrl: string;
    gitUrl: string;
    downloadUrl: string | null;
    ext: string;
  }[];
  lastCommit: {
    sha: string;
    message: string;
    author: string;
    authorEmail: string;
    date: string;
    htmlUrl: string;
    avatarUrl: string | null;
    authorProfileUrl: string | null;
    shortSha: string;
  } | null;
  subtree: RepoTreeEntry[];
  stats: {
    totalFiles: number;
    totalFolders: number;
    totalSize: number;
    maxDepth: number;
    extFrequency: Record<string, number>;
    dominantExt: string | null;
  };
  flags: {
    hasIndex: boolean;
    hasConfig: boolean;
    hasReadme: boolean;
    hasTests: boolean;
    hasStyles: boolean;
    hasDotfiles: boolean;
    isEntryPoint: boolean;
    isConfigFolder: boolean;
    isTestFolder: boolean;
  };
}

export interface FileContext {
  id: string;
  name: string;
  path: string;
  ext: string;
  depth: number;
  isLarge: boolean;
  github: {
    sha: string;
    size: number;
    encoding: string;
    htmlUrl: string;
    gitUrl: string;
    downloadUrl: string | null;
    type: string;
  };
  content: string;
  metrics: {
    lineCount: number;
    charCount: number;
    codeLines: number;
    commentLines: number;
    emptyLines: number;
    byteSize: number;
  };
  analysis: {
    imports: string[];
    exports: string[];
    todoComments: string[];
    consoleLogs: number;
    functionCount: number;
    classCount: number;
    complexity: {
      score: number;
      branches: number;
      loops: number;
      asyncOps: number;
    };
    logicType: string;
    isReact: boolean;
    isTypeScript: boolean;
    isTest: boolean;
    isConfig: boolean;
    hasJsx: boolean;
  };
  commits: {
    sha: string;
    shortSha: string;
    message: string;
    author: string;
    authorEmail: string;
    date: string;
    htmlUrl: string;
    avatarUrl: string | null;
    profileUrl: string | null;
    committer: string;
    committerEmail: string;
    verified: boolean;
  }[];
  contributors: {
    name: string;
    email: string;
    avatarUrl: string | null;
    profileUrl: string | null;
    commits: number;
    firstCommit: string;
    lastCommit: string;
  }[];
  topContributor: {
    name: string;
    email: string;
    avatarUrl: string | null;
    profileUrl: string | null;
    commits: number;
    firstCommit: string;
    lastCommit: string;
  } | null;
  firstCommit: FileContext["commits"][number] | null;
  latestCommit: FileContext["commits"][number] | null;
}
