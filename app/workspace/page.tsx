import Link from "next/link";
import { TreePine, Orbit, Waypoints, Cpu, Search } from "lucide-react";
import { getRepoData } from "@/lib/github";
import { FileNode, transformToTree } from "@/modes/TreeMapper";
import TreeView from "@/components/TreeView";

export default async function Workspace({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const activeMode = (params.mode as string) || "tree";
  const repoUrl = params.repo as string;
  const filter = (params.filter as string) || ""; // Get filter from URL

  let treeRoot: FileNode | null = null;
  let error: string | null = null;

  if (repoUrl) {
    try {
      const cleanUrl = repoUrl.replace(/\/$/, "");
      const [owner, repo] = cleanUrl
        .replace("https://github.com/", "")
        .split("/");
      const { tree, metadata } = await getRepoData(owner, repo);
      treeRoot = transformToTree(tree, repo, metadata);
    } catch (e) {
      console.error(e);
      error = "Could not fetch repository. Check the URL or try again later.";
    }
  }

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
      // Pass the server-side filter string to TreeView
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
    <div className="h-screen w-full bg-[#080d16] text-gray-100 flex flex-col overflow-hidden font-sans p-4">
      <div className="flex flex-1 min-h-0 w-full max-w-[100vw] mx-auto gap-4">
        {/* left */}
        <div className="flex flex-col flex-1 min-h-0">
          <div className="shrink-0 flex items-center gap-4 px-4 py-3 bg-slate-950 border border-slate-800 rounded-t-2xl">
            <form
              action="/workspace"
              method="GET"
              className="flex flex-1 items-center gap-2 bg-[#0a0f1a] border border-slate-800 rounded-xl px-3 py-1.5 focus-within:border-blue-500/50 transition-colors"
            >
              <input
                name="repo"
                defaultValue={repoUrl?.replace("https://github.com/", "")}
                type="text"
                placeholder="Enter github repo url"
                className="flex-1 bg-transparent outline-none font-mono text-sm placeholder:text-slate-700"
              />
              <input type="hidden" name="mode" value={activeMode} />
              <button
                type="submit"
                className="flex group items-center gap-2 border-2 border-gray-600 text-gray-300 px-3 py-1 rounded-full hover:border-blue-500 transition-colors text-sm"
              >
                <Orbit
                  size={14}
                  className="text-blue-500 group-hover:animate-spin"
                />
                Load
              </button>
            </form>

            <form
              action="/workspace"
              method="GET"
              className={`flex items-center gap-2 bg-[#0a0f1a] border rounded-xl px-3 py-1.5 transition-all ${!repoUrl || error ? "border-red-900/20 opacity-40" : "border-slate-800 focus-within:border-blue-500/30"}`}
            >
              <input type="hidden" name="repo" value={repoUrl || ""} />
              <input type="hidden" name="mode" value={activeMode} />
              <Search
                size={14}
                className={
                  !repoUrl || error ? "text-slate-800" : "text-slate-500"
                }
              />
              <input
                name="filter"
                defaultValue={filter}
                disabled={!repoUrl || !!error}
                type="text"
                placeholder="Filter files"
                className="bg-transparent outline-none font-mono text-xs placeholder:text-slate-800 w-24 focus:w-40 transition-all disabled:cursor-not-allowed"
              />
              <button type="submit" className="hidden" />
            </form>

            <div className="shrink-0 flex gap-1 bg-[#0a0f1a] p-1 rounded-xl border border-slate-800">
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
            </div>
          </div>

          {/* heat map / errors */}
          <div className="relative flex-1 min-h-0 border-x border-b border-slate-800 rounded-b-2xl overflow-hidden bg-[#020408]">
            {renderWorkspaceState()}
          </div>
        </div>

        {/* right */}
        <div className="w-80 shrink-0 flex flex-col bg-[#05070a] border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <div className="shrink-0 px-4 py-3 bg-slate-950 border-b border-slate-800 flex items-center gap-2">
            <Cpu size={14} className="text-blue-500" />
            <span className="text-[10px] font-mono font-bold text-gray-300 uppercase tracking-widest">
              AI Analyzer
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin scrollbar-thumb-slate-800/50">
            <div className="flex flex-col items-start max-w-[90%]">
              <div className="bg-slate-900 border border-slate-800 p-3 rounded-2xl rounded-tl-none text-[11px] leading-relaxed text-slate-300 font-mono">
                Greetings. Select a file from the tree to begin the analysis.
              </div>
              <span className="text-[8px] text-slate-600 mt-1 ml-1 font-mono uppercase">
                System
              </span>
            </div>

            <div className="flex flex-col items-start max-w-[90%] opacity-40">
              <div className="bg-slate-900 border border-slate-800 p-3 rounded-2xl rounded-tl-none w-full space-y-2">
                <div className="h-1.5 w-full bg-slate-800 rounded" />
                <div className="h-1.5 w-3/4 bg-slate-800 rounded" />
              </div>
            </div>
          </div>

          <div className="shrink-0 p-3 bg-slate-950 border-t border-slate-800">
            <input
              disabled
              type="text"
              placeholder="Any questions?"
              className="w-full bg-[#0a0f1a] border border-slate-800 text-[11px] font-mono text-slate-500 px-4 py-2 rounded-xl outline-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
