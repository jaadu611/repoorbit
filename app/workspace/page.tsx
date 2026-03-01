import { getRepoData } from "@/lib/github";
import { FileNode, transformToTree } from "@/modes/TreeMapper";
import type { RepoContext } from "@/lib/types";
import WorkspaceLayout from "@/components/WorkspaceLayout";

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
}

export default async function Workspace({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const activeMode = (params.mode as string) || "tree";
  const repoUrl = params.repo as string;
  const filter = (params.filter as string) || "";

  let treeRoot: FileNode | null = null;
  let error: string | null = null;
  let fullRepoData: FullRepoData | null = null;

  if (repoUrl) {
    try {
      const cleanUrl = repoUrl.replace(/\/$/, "");
      const [owner, repo] = cleanUrl
        .replace("https://github.com/", "")
        .split("/");

      const { tree, metadata, readme, repoContext } = await getRepoData(
        owner,
        repo,
      );

      fullRepoData = {
        tree,
        metadata,
        readme,
        repoContext,
      };

      treeRoot = transformToTree(tree, repo, metadata);
    } catch (e) {
      console.error(e);
      error = "Could not fetch repository. Check the URL or try again later.";
    }
  }

  return (
    <WorkspaceLayout
      repoUrl={repoUrl}
      activeMode={activeMode}
      filter={filter}
      fullRepoData={fullRepoData}
      treeRoot={treeRoot}
      error={error}
    />
  );
}
