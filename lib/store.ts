// all ai generated

import { create } from "zustand";
import type { RepoContext, FolderContext, FileContext } from "@/lib/types";

type SelectionType = "root" | "repo" | "folder" | "file";

interface Selection {
  type: SelectionType;
  name: string;
  path: string;
  repoContext: RepoContext | null;
  folderContext: FolderContext | null;
  fileContext: FileContext | null;
}

interface SelectionStore {
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

export const useSelectionStore = create<SelectionStore>((set) => ({
  selection: {
    type: "root",
    name: "",
    path: "/",
    repoContext: null,
    folderContext: null,
    fileContext: null,
  },
  isInitialized: false,

  // ── setSelection ─────────────────────────────────────────────────────────
  // KEY FIX: repoContext is NEVER wiped by folder/file clicks — it persists
  // across the entire session once populated. Only the "active" context slot
  // (folderContext / fileContext) is cleared when switching between them.
  setSelection: (type, name, path, details) =>
    set((state) => ({
      isInitialized: true,
      selection: {
        type,
        name,
        path,
        // repoContext: only update when explicitly navigating to repo/root.
        // For folder/file clicks, carry the existing value forward.
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
        // repoContext preserved — do NOT clear it
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
        // repoContext preserved — do NOT clear it
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
    }),
}));

// ─── Convenience selectors ────────────────────────────────────────────────────
export const useSelectionType = () =>
  useSelectionStore((s) => s.selection.type);
export const useRepoContext = () =>
  useSelectionStore((s) => s.selection.repoContext);
export const useFolderContext = () =>
  useSelectionStore((s) => s.selection.folderContext);
export const useFileContext = () =>
  useSelectionStore((s) => s.selection.fileContext);
export const useIsInitialized = () => useSelectionStore((s) => s.isInitialized);
