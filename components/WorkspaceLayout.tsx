"use client";

import Link from "next/link";
import { TreePine, Orbit, Waypoints, Search } from "lucide-react";
import TreeView from "@/components/TreeView";
import AiChat from "@/components/AiChat";
import { FileNode } from "@/modes/TreeMapper";
import { FullRepoData } from "@/app/workspace/page";

interface WorkspaceLayoutProps {
  repoUrl: string | undefined;
  activeMode: string;
  filter: string;
  fullRepoData: FullRepoData | null;
  treeRoot: FileNode | null;
  error: string | null;
}

export default function WorkspaceLayout({
  repoUrl,
  activeMode,
  filter,
  fullRepoData,
  treeRoot,
  error,
}: WorkspaceLayoutProps) {
  const renderWorkspaceState = () => {
    if (error) {
      return (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-10">
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-6 py-4 text-red-400 font-mono text-sm">
            {error}
          </div>
        </div>
      );
    }

    if (!repoUrl) {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-slate-600 font-mono text-[11px] uppercase tracking-[0.3em]">
            Enter URL Above
          </p>
        </div>
      );
    }

    if (activeMode === "tree" && treeRoot) {
      return <TreeView data={treeRoot} filter={filter} />;
    }

    return (
      <div className="w-full h-full flex items-center justify-center">
        <p className="text-slate-700 font-mono text-[11px] uppercase tracking-widest">
          Flow Engine Initializing
        </p>
      </div>
    );
  };

  return (
    <div
      id="workspace-viewport"
      className="h-[92vh] w-full bg-[#080d16] text-gray-100 flex gap-4 overflow-hidden font-sans p-4 max-w-[100vw] mx-auto"
    >
      <section className="flex flex-col flex-1 min-h-0 bg-transparent">
        <header className="flex items-center gap-4 px-4 py-3 bg-gray-900 border-2 border-gray-600 rounded-t-2xl">
          <form
            action="/workspace"
            method="GET"
            className="flex flex-1 items-center gap-2 bg-gray-900 border-2 border-gray-600 rounded-xl px-3 py-1.5 focus-within:border-blue-500/50 transition-colors"
          >
            <input
              key={`repo-input-${repoUrl}`}
              name="repo"
              defaultValue={repoUrl?.replace("https://github.com/", "") || ""}
              type="text"
              placeholder="Enter github repo url"
              className="flex-1 bg-transparent outline-none font-mono text-sm placeholder:text-slate-600"
            />
            <input type="hidden" name="mode" value={activeMode} />
            <button
              type="submit"
              className="flex cursor-pointer items-center gap-2 border-2 border-gray-600 text-gray-300 px-3 py-1 rounded-full hover:border-blue-500 transition-colors text-sm"
            >
              <Orbit size={14} className="text-blue-500" />
              Load
            </button>
          </form>

          <form
            action="/workspace"
            method="GET"
            className={`flex items-center gap-2 bg-gray-900 border-2 border-gray-600 rounded-xl px-3 py-1.5 transition-all ${
              !repoUrl || error
                ? "border-red-900/20 opacity-40"
                : "border-gray-600 focus-within:border-blue-500/30"
            }`}
          >
            <input type="hidden" name="repo" value={repoUrl || ""} />
            <input type="hidden" name="mode" value={activeMode} />
            <Search
              size={14}
              className={!repoUrl || error ? "text-slate-800" : "text-gray-500"}
            />
            <input
              key={`filter-input-${filter}`}
              name="filter"
              defaultValue={filter}
              disabled={!repoUrl || !!error}
              type="text"
              placeholder="Filter files"
              className="bg-transparent outline-none font-mono text-xs placeholder:text-gray-600 w-24 focus:w-40 transition-all disabled:cursor-not-allowed"
            />
            <button type="submit" className="hidden" />
          </form>

          <nav className="shrink-0 flex gap-1 bg-gray-900 border-2 border-gray-600 p-1 rounded-xl">
            {[
              { id: "tree", label: "Tree", icon: TreePine },
              { id: "flow", label: "Flow", icon: Waypoints },
            ].map((mode) => (
              <Link
                key={mode.id}
                href={`?repo=${repoUrl || ""}&mode=${mode.id}${filter ? `&filter=${filter}` : ""}`}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${
                  activeMode === mode.id
                    ? "bg-blue-600 text-white"
                    : "text-slate-500 hover:text-slate-300"
                }`}
              >
                <mode.icon size={15} />
                {mode.label}
              </Link>
            ))}
          </nav>
        </header>

        <div className="relative flex-1 min-h-0 border-2 border-t-0 border-gray-600 rounded-b-2xl overflow-hidden bg-gray-900">
          {renderWorkspaceState()}
        </div>
      </section>

      {fullRepoData && (
        <aside className="shrink-0 h-full">
          <AiChat key={`ai-chat-${repoUrl}`} repoData={fullRepoData} />
        </aside>
      )}
    </div>
  );
}
