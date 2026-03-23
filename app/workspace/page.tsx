import { getRepoData, parseRepoInput } from "@/lib/github";
import { transformToTree } from "@/modes/TreeMapper";
import type { FileNode, FullRepoData } from "@/lib/types";
import WorkspaceLayout from "@/components/WorkspaceLayout";

export default async function Workspace({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const activeMode = (params.mode as string) || "tree";
  const rawRepo = params.repo as string | undefined;
  const filter = (params.filter as string) || "";

  let repoUrl: string | undefined;
  if (rawRepo) {
    try {
      const { owner, repo } = parseRepoInput(rawRepo);
      repoUrl = `${owner}/${repo}`;
    } catch {
      repoUrl = rawRepo;
    }
  }

  let treeRoot: FileNode | null = null;
  let error: string | null = null;
  let fullRepoData: FullRepoData | null = null;

  if (repoUrl) {
    try {
      const { owner, repo } = parseRepoInput(repoUrl);

      const {
        tree,
        metadata,
        readme,
        repoContext,
        filesMetadata,
        importGraph,
      } = await getRepoData(owner, repo);

      fullRepoData = {
        tree,
        metadata,
        readme,
        repoContext,
        filesMetadata,
        importGraph,
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
