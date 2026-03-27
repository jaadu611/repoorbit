import { create } from "zustand";
import type {
  RepoContext,
  FolderContext,
  FileContext,
  SelectionStore,
  CommitDetail,
} from "@/lib/types";

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
    logicType: string;
    isReact: boolean;
    isTypeScript: boolean;
    isTest: boolean;
    isConfig: boolean;
    hasJsx: boolean;
  };
}

export const useSelectionStore = create<
  SelectionStore & {
    filesMetadata: LightFileMetadata[];
    importGraph: Record<string, string[]>;
    setFilesMetadata: (
      files:
        | LightFileMetadata[]
        | ((prev: LightFileMetadata[]) => LightFileMetadata[]),
      graph?: Record<string, string[]>,
    ) => void;
    addFileMetadata: (file: LightFileMetadata) => void;
    setCommitsByAuthor: (
      commitsByAuthor: Record<string, CommitDetail[]>,
    ) => void;
    addCommitsForAuthor: (author: string, commits: CommitDetail[]) => void;
  }
>((set) => ({
  selection: {
    type: "root",
    name: "",
    path: "/",
    repoContext: null,
    folderContext: null,
    fileContext: null,
  },
  isInitialized: false,
  filesMetadata: [],
  importGraph: {},

  setFilesMetadata: (files, graph) =>
    set((state) => {
      const nextFiles =
        typeof files === "function" ? files(state.filesMetadata) : files;
      const nextGraph = graph ?? state.importGraph;
      return { filesMetadata: nextFiles, importGraph: nextGraph };
    }),

  addFileMetadata: (file) =>
    set((state) => ({
      filesMetadata: [...state.filesMetadata, file],
      importGraph: {
        ...state.importGraph,
        [file.path]: file.resolvedImports,
      },
    })),

  setCommitsByAuthor: (commitsByAuthor) =>
    set((state) => {
      if (!state.selection.repoContext) return {};
      const total = Object.values(commitsByAuthor).reduce(
        (sum, commits) => sum + commits.length,
        0,
      );
      return {
        selection: {
          ...state.selection,
          repoContext: {
            ...state.selection.repoContext,
            commitsByAuthor,
            totalCommitsFetched: total,
          },
        },
      };
    }),

  addCommitsForAuthor: (author, commits) =>
    set((state) => {
      if (!state.selection.repoContext) return {};
      const prev = state.selection.repoContext.commitsByAuthor ?? {};
      const merged = {
        ...prev,
        [author]: [...(prev[author] ?? []), ...commits],
      };
      const total = Object.values(merged).reduce((sum, c) => sum + c.length, 0);
      return {
        selection: {
          ...state.selection,
          repoContext: {
            ...state.selection.repoContext,
            commitsByAuthor: merged,
            totalCommitsFetched: total,
          },
        },
      };
    }),

  setSelection: (type, name, path, details) =>
    set((state) => ({
      isInitialized: true,
      selection: {
        type,
        name,
        path,
        repoContext:
          type === "repo" || type === "root"
            ? ((details as RepoContext) ?? state.selection.repoContext)
            : state.selection.repoContext,
        folderContext: type === "folder" ? (details as FolderContext) : null,
        fileContext: type === "file" ? (details as FileContext) : null,
      },
    })),

  setRepoContext: (ctx) =>
    set((state) => ({
      isInitialized: true,
      selection: {
        ...state.selection,
        type: "repo",
        name: ctx.meta.name,
        path: "/",
        repoContext: ctx,
        folderContext: null,
        fileContext: null,
      },
    })),

  setFolderContext: (ctx) =>
    set((state) => ({
      isInitialized: true,
      selection: {
        ...state.selection,
        type: "folder",
        name: ctx.name,
        path: ctx.path,
        folderContext: ctx,
        fileContext: null,
      },
    })),

  setFileContext: (ctx) =>
    set((state) => ({
      isInitialized: true,
      selection: {
        ...state.selection,
        type: "file",
        name: ctx.name,
        path: ctx.path,
        folderContext: null,
        fileContext: ctx,
      },
    })),

  resetToRepo: (repoMeta) =>
    set({
      isInitialized: true,
      selection: {
        type: "root",
        name: repoMeta.name,
        path: "/",
        repoContext: null,
        folderContext: null,
        fileContext: null,
      },
      filesMetadata: [],
      importGraph: {},
    }),
}));


