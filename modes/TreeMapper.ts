import { FileNode } from "@/lib/types";

export const transformToTree = (
  flatFiles: any[],
  repoName: string,
  metadata: any,
): FileNode => {
  const rootNode: FileNode = {
    path: "",
    name: repoName,
    type: "root",
    size: 0,
    details: metadata,
    children: [],
  };

  const map: { [key: string]: FileNode } = { "": rootNode };

  const sortedFiles = [...flatFiles].sort(
    (a, b) => a.path.split("/").length - b.path.split("/").length,
  );

  sortedFiles.forEach((file) => {
    const parts = file.path.split("/");
    const fileName = parts[parts.length - 1];

    const newNode: FileNode = {
      path: file.path,
      name: fileName,
      type: file.type === "tree" ? "folder" : "file",
      size: file.size || 0,
      ...(file.type === "tree" ? { children: [] } : {}),
    };

    map[file.path] = newNode;

    const parentPath = parts.slice(0, -1).join("/");
    const parent = map[parentPath];

    if (parent && parent.children) {
      parent.children.push(newNode);
    }
  });

  const sortChildren = (node: FileNode): void => {
    if (!node.children) return;

    node.children.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "folder" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    node.children.forEach(sortChildren);
  };

  sortChildren(rootNode);

  return rootNode;
};
export const enrichNode = (node: FileNode, commitData: any): FileNode => {
  return {
    ...node,
    author: commitData.commit.author.name,
    createdAt: commitData.commit.author.date,
    lastModified: commitData.commit.committer.date,
  };
};
