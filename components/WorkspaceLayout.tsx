"use client";

import { useState } from "react";
import Link from "next/link";
import { TreePine, Orbit, Waypoints, Search, Cpu } from "lucide-react";
import TreeView from "@/components/TreeView";
import AiChat from "@/components/AiChat";
import { WorkspaceLayoutProps } from "@/lib/types";

export default function WorkspaceLayout({
  repoUrl,
  activeMode,
  filter,
  fullRepoData,
  treeRoot,
  error,
}: WorkspaceLayoutProps) {
  const [isChatOpen, setIsChatOpen] = useState(true);

  const renderWorkspaceState = () => {
    if (error) {
      return (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-10 backdrop-blur-[1px]">
          <div className="bg-red-500/5 border border-red-500/20 rounded-lg px-4 py-2.5 text-red-400/90 font-mono text-[11px] max-w-[80%] text-center">
            {error}
          </div>
        </div>
      );
    }

    if (!repoUrl) {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-slate-600 font-mono text-[9px] uppercase tracking-[0.4em] opacity-70">
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
        <div className="flex flex-col items-center gap-3">
          <p className="text-slate-700 font-mono text-[9px] uppercase tracking-[0.3em] animate-pulse">
            Flow Engine Initializing
          </p>
        </div>
      </div>
    );
  };

  return (
    <div
      id="workspace-viewport"
      className="h-[93.6vh] w-full bg-[#05080f] text-gray-100 flex gap-3 overflow-hidden font-sans p-3 mx-auto"
    >
      <section className="flex flex-col flex-1 min-h-0 bg-transparent">
        <header className="flex items-center gap-3 px-3 py-2 bg-gray-950 border border-gray-700/50 rounded-t-xl">
          <form
            action="/workspace"
            method="GET"
            className="flex flex-1 items-center gap-2 bg-gray-900 border border-gray-700/50 rounded-lg px-2.5 py-1 focus-within:border-blue-500/40 transition-colors"
          >
            <input
              key={`repo-input-${repoUrl}`}
              name="repo"
              defaultValue={repoUrl || ""}
              type="text"
              placeholder="owner/repo or github.com/owner/repo"
              className="flex-1 bg-transparent outline-none font-mono text-[13px] placeholder:text-slate-600"
            />
            <input type="hidden" name="mode" value={activeMode} />
            <button
              type="submit"
              className="flex cursor-pointer items-center gap-1.5 border border-gray-700/50 text-gray-400 px-2.5 py-0.5 rounded-md hover:border-blue-500/50 transition-colors text-[12px] font-medium"
            >
              <Orbit size={12} className="text-blue-500" />
              Load
            </button>
          </form>

          <form
            action="/workspace"
            method="GET"
            className={`flex items-center gap-2 bg-gray-900 border border-gray-700/50 rounded-lg px-2.5 py-1 transition-all ${
              !repoUrl || error
                ? "border-red-900/10 opacity-30"
                : "border-gray-700/50 focus-within:border-blue-500/20"
            }`}
          >
            <input type="hidden" name="repo" value={repoUrl || ""} />
            <input type="hidden" name="mode" value={activeMode} />
            <Search
              size={12}
              className={!repoUrl || error ? "text-slate-800" : "text-gray-500"}
            />
            <input
              key={`filter-input-${filter}`}
              name="filter"
              defaultValue={filter}
              disabled={!repoUrl || !!error}
              type="text"
              placeholder="Filter"
              className="bg-transparent outline-none font-mono text-[11px] placeholder:text-gray-600 w-16 focus:w-32 transition-all disabled:cursor-not-allowed"
            />
            <button type="submit" className="hidden" />
          </form>

          <nav className="shrink-0 flex gap-0.5 bg-gray-900 border border-gray-700/50 p-0.5 rounded-lg">
            {[
              { id: "tree", label: "Tree", icon: TreePine },
              { id: "flow", label: "Flow", icon: Waypoints },
            ].map((mode) => (
              <Link
                key={mode.id}
                href={`?repo=${repoUrl || ""}&mode=${mode.id}${filter ? `&filter=${filter}` : ""}`}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-bold transition-all ${
                  activeMode === mode.id
                    ? "bg-blue-600/90 text-white shadow-sm"
                    : "text-slate-500 hover:text-slate-300 hover:bg-white/5"
                }`}
              >
                <mode.icon size={13} />
                {mode.label}
              </Link>
            ))}
          </nav>

          <button
            onClick={() => setIsChatOpen(!isChatOpen)}
            className={`relative cursor-pointer shrink-0 flex items-center justify-center w-7 h-7 rounded-md border transition-all duration-200 active:scale-95 ${
              isChatOpen
                ? "bg-blue-500/10 border-blue-500/30 text-blue-400 shadow-[0_0_10px_rgba(59,130,246,0.1)]"
                : "bg-gray-900 border-gray-700/50 text-gray-500 hover:text-slate-300 hover:border-gray-600"
            }`}
            title={isChatOpen ? "Close AI Chat" : "Open AI Chat"}
          >
            <Cpu size={13} />
          </button>
        </header>

        <div className="relative flex-1 min-h-0 border border-t-0 border-gray-700/50 rounded-b-xl overflow-hidden bg-gray-950">
          {renderWorkspaceState()}
        </div>
      </section>

      {fullRepoData && isChatOpen && (
        <aside className="shrink-0 h-full animate-in slide-in-from-right duration-300">
          <AiChat key={`ai-chat-${repoUrl}`} repoData={fullRepoData} />
        </aside>
      )}
    </div>
  );
}
