export interface RepoTreeEntry {
  path: string;
  name: string;
  type: "folder" | "file";
  ext: string;
  size: number;
  depth: number;
  sha: string;
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

export interface CommitDetail {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  authorEmail: string;
  date: string;
  htmlUrl: string;
  avatarUrl: string | null;
  profileUrl: string | null;
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
    htmlUrl: string;
  } | null;

  latestCommit: {
    sha: string;
    shortSha: string;
    message: string;
    author: string;
    authorEmail: string;
    date: string;
    htmlUrl: string;
    avatarUrl: string | null;
    profileUrl: string | null;
  } | null;

  recentCommits: {
    sha: string;
    shortSha: string;
    message: string;
    author: string;
    date: string;
    htmlUrl: string;
  }[];

  commitsByAuthor: Record<string, CommitDetail[]>;
  totalCommitsFetched: number;

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

  releases: {
    tagName: string;
    name: string;
    publishedAt: string;
    htmlUrl: string;
    prerelease: boolean;
    draft: boolean;
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

  issues: {
    number: number;
    title: string;
    state: "open" | "closed";
    author: string | null;
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
    labels: string[];
    comments: number;
    htmlUrl: string;
    body: string | null;
  }[];

  pulls: {
    number: number;
    title: string;
    state: "open" | "closed";
    merged: boolean;
    author: string | null;
    createdAt: string;
    updatedAt: string;
    mergedAt: string | null;
    closedAt: string | null;
    baseBranch: string | null;
    headBranch: string | null;
    labels: string[];
    comments: number;
    htmlUrl: string;
    body: string | null;
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
  size: number;
  depth: number;
  isLarge: boolean;
  imports: string[];
  resolvedImports: string[];
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

export type FileNode = {
  path: string;
  name: string;
  type: "file" | "folder" | "root";
  size: number;
  author?: string;
  createdAt?: string;
  lastModified?: string;
  details?: {
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
  };
  tree?: any;
  children?: FileNode[];
};

export interface FullRepoData {
  tree: any[];
  readme: string;
  metadata: {
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
  };
  repoContext: RepoContext;
  filesMetadata: {
    path: string;
    name: string;
    type: "file" | "folder";
    ext: string;
    size: number;
    depth: number;
    isLarge: boolean;
    sha: string;
    content: string;
    imports: string[];
    resolvedImports: string[];
    metrics: {
      lineCount: number;
      charCount: number;
      codeLines: number;
      commentLines: number;
      emptyLines: number;
    };
    analysis: {
      exports: string[];
      todoComments: string[];
      functionCount: number;
      classCount: number;
      isReact: boolean;
      isTypeScript: boolean;
      isTest: boolean;
      isConfig: boolean;
      hasJsx: boolean;
      logicType: string;
    };
  }[];
  importGraph: Record<string, { imports: string[]; imported_by: string[] }>;
}

export interface WorkspaceLayoutProps {
  repoUrl: string | undefined;
  activeMode: string;
  filter: string;
  fullRepoData: FullRepoData | null;
  treeRoot: FileNode | null;
  error: string | null;
}

export interface AiChatProps {
  repoData: FullRepoData;
}

export interface TreeNode {
  id: string;
  name: string;
  type: "root" | "folder" | "file";
  ext: string;
  size: number;
  sha?: string;
  details?: {
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
  };
  fileDetails?: {
    depth: number;
    path: string;
    isLarge: boolean;
    branchWeight: number;
  };
  originalChildren: TreeNode[];
  children?: TreeNode[] | null;
}

export interface AnimatingNode {
  id: string;
  cx: number;
  cy: number;
  tx: number;
  ty: number;
  opacity: number;
  scale: number;
  born: number;
  closing: boolean;
}

export interface AnimatingLink {
  childId: string;
  progress: number;
  born: number;
  closing: boolean;
}

export type SelectionType = "root" | "repo" | "folder" | "file";

export interface Selection {
  type: SelectionType;
  name: string;
  path: string;
  repoContext: RepoContext | null;
  folderContext: FolderContext | null;
  fileContext: FileContext | null;
}

export interface SelectionStore {
  selection: Selection;
  isInitialized: boolean;

  setSelection: (
    type: SelectionType,
    name: string,
    path: string,
    details: RepoContext | FolderContext | FileContext | null,
  ) => void;

  setRepoContext: (ctx: RepoContext) => void;
  setFolderContext: (ctx: FolderContext) => void;
  setFileContext: (ctx: FileContext) => void;
  resetToRepo: (repoMeta: RepoContext["meta"]) => void;
}

export interface NotebookEntry {
  name: string;
  sub_question: string;
}

export interface NotebookPlan {
  notebooks?: NotebookEntry[];
  direct_answer?: string;
}

export interface JobStatus {
  status: "pending" | "done" | "error";
  result?: string;
  partialResult?: string;
  error?: string;
  statusText?: string;
  progress?: number;
}

export interface LightFileMetadata {
  path: string;
  name: string;
  ext: string;
  size: number;
  depth: number;
  isLarge: boolean;
  imports: string[];
  resolvedImports: string[];
  metrics: {
    lineCount: number;
    charCount: number;
    codeLines: number;
    commentLines: number;
    emptyLines: number;
  };
  analysis: {
    exports: string[];
    todoComments: string[];
    functionCount: number;
    classCount: number;
    isReact: boolean;
    isTypeScript: boolean;
    isTest: boolean;
    isConfig: boolean;
    hasJsx: boolean;
    logicType: string;
  };
}

export interface GapSearchResult {
  filePath: string;
  score: number;
  reason: string;
}

export type RepoLanguage = "c" | "web" | "go" | "rust" | "python" | "java" | "mixed";

export type ImportRole = "Entry Point" | `Depth ${number}` | "Utility";

export type QueryIntent =
  | "contributors"
  | "commits"
  | "branches"
  | "issues"
  | "pulls"
  | "repo_meta"
  | "tree"
  | "code"
  | "test";

export type CodeFocus = "targeted" | "generic";

export interface FunctionBlock {
  name: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface ScoredFile {
  file: any;
  score: number;
}

export interface Block {
  group: string;
  text: string;
  filePath?: string;
}

export interface ExpertPlan {
  files?: string[];
  intents?: QueryIntent[];
  focus?: CodeFocus;
}

export interface SymbolExtraction {
  defined: string[];
  used: string[];
}

export interface BidirectionalGraph {
  imports: Record<string, string[]>;
  imported_by: Record<string, string[]>;
}
