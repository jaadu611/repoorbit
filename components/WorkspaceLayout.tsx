import { useState, useEffect, useRef } from "react";
import {
  ChevronDown,
  Cpu,
} from "lucide-react";
import TreeView from "@/components/TreeView";
import AiChat from "@/components/AiChat";
import { WorkspaceLayoutProps } from "@/lib/core/types";

// Get VS Code API
const vscode = (window as any).acquireVsCodeApi?.();
if (vscode) {
  (window as any).vscode = vscode;
}

export default function WorkspaceLayout({
  repoUrl: initialRepoUrl,
  activeMode: initialMode,
  filter: initialFilter,
  fullRepoData,
  treeRoot,
  error,
}: WorkspaceLayoutProps) {
  const [isChatOpen, setIsChatOpen] = useState(true);
  const [chatWidth, setChatWidth] = useState(400);
  const [isResizing, setIsResizing] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [showCloneModal, setShowCloneModal] = useState(false);
  const [clonePath, setClonePath] = useState("./");
  const [isCloning, setIsCloning] = useState(false);
  const [activeMode, setActiveMode] = useState(initialMode || "tree");
  const [filter, setFilter] = useState(initialFilter || "");
  const [isWorkspaceEmpty, setIsWorkspaceEmpty] = useState(false);

  // Resize handler
  const startResizing = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const newWidth = window.innerWidth - e.clientX;
      const maxWidth = window.innerWidth;
      const minWidth = 320;

      if (newWidth > minWidth && newWidth < maxWidth - 50) {
        setChatWidth(newWidth);
      } else if (newWidth >= maxWidth - 50) {
        setChatWidth(maxWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
    } else {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "default";
    }

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "default";
    };
  }, [isResizing]);

  // Real-time data from extension
  const [data, setData] = useState({
    treeRoot: treeRoot,
    fullRepoData: fullRepoData,
    isLoading: false,
    error: error,
  });

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      switch (message.command) {
        case "setRepoData":
          setData({
            treeRoot: message.treeRoot,
            fullRepoData: message.fullRepoData,
            isLoading: false,
            error: null,
          });
          break;
        case "setError":
          setData((prev) => ({
            ...prev,
            isLoading: false,
            error: message.text,
          }));
          setIsCloning(false);
          break;
        case "cloneSuccess":
          setIsCloning(false);
          setShowCloneModal(false);
          // Refresh workspace status after clone
          vscode?.postMessage({ command: "checkWorkspaceStatus" });
          vscode?.postMessage({
            command: "alert",
            text: `🚀 Success! Repository cloned to ${message.path}. Antigravity skills and rules have been initialized.`,
          });
          break;
        case "workspaceStatus":
          setIsWorkspaceEmpty(message.isEmpty);
          break;
      }
    };

    window.addEventListener("message", handleMessage);
    // Initial check
    vscode?.postMessage({ command: "checkWorkspaceStatus" });
    return () => window.removeEventListener("message", handleMessage);
  }, []);


  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!repoUrl) return;

    setData((prev) => ({ ...prev, isLoading: true, error: null }));

    if (vscode) {
      vscode.postMessage({
        command: "analyzeRepo",
        url: repoUrl,
      });
    } else {
      console.warn(
        "[Orbit] No VSCode API detected. Running in Browser Preview mode.",
      );
      // Stop loading after 1s for web testing
      setTimeout(() => {
        setData((prev) => ({
          ...prev,
          isLoading: false,
          error:
            "Running in Browser Preview mode. Real analysis requires VS Code.",
        }));
      }, 1000);
    }
  };

  const [token, setToken] = useState("");

  const handleSaveToken = () => {
    vscode?.postMessage({
      command: "saveToken",
      token: token,
    });
    // Retry analysis
    handleSearch({ preventDefault: () => {} } as any);
  };

  const renderWorkspaceState = () => {
    if (data.error) {
      const isRateLimited = data.error.includes("Rate limited");
      return (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-20 backdrop-blur-xl">
          <div className="border border-red-500/30 bg-red-500/5 rounded-xl p-8 max-w-md w-full shadow-2xl flex flex-col gap-6 text-center">
            <div className="flex flex-col gap-2">
              <h3 className="text-red-400 font-bold text-lg">
                Analysis Blocked
              </h3>
              <p className="text-[var(--color-antigravity-text-secondary)] font-mono text-xs leading-relaxed">
                {data.error}
              </p>
            </div>

            {isRateLimited && (
              <div className="flex flex-col gap-3">
                <p className="text-[var(--color-antigravity-text-secondary)] text-[10px] uppercase tracking-widest text-left">
                  Paste GITHUB_TOKEN
                </p>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="bg-black/60 border border-[var(--color-antigravity-border)] rounded px-3 py-2 text-xs font-mono text-zinc-300 outline-none focus:border-[var(--color-antigravity-accent)]/50 transition-all"
                  placeholder="ghp_..."
                />
                <button
                  onClick={handleSaveToken}
                  className="bg-[var(--color-antigravity-accent)] hover:opacity-90 text-white font-bold py-2 rounded text-[11px] uppercase tracking-widest transition-all shadow-lg shadow-blue-900/20"
                >
                  Unlock Engine
                </button>
                <a
                  href="https://github.com/settings/tokens"
                  target="_blank"
                  className="text-zinc-600 hover:text-zinc-400 text-[9px] uppercase tracking-tighter transition-all"
                >
                  Create a classic token with "repo" scope →
                </a>
              </div>
            )}

            {!isRateLimited && (
              <button
                onClick={() => setData((prev) => ({ ...prev, error: null }))}
                className="text-zinc-500 hover:text-zinc-300 text-[10px] uppercase tracking-widest"
              >
                Try Again
              </button>
            )}
          </div>
        </div>
      );
    }

    if (!repoUrl || (!data.isLoading && !data.treeRoot)) {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[var(--color-antigravity-bg)]">
          <p className="text-zinc-800 font-mono text-[10px] uppercase tracking-[0.6em] animate-pulse">
            Terminal Ready
          </p>
        </div>
      );
    }

    if (data.isLoading) {
      return (
        <div className="w-full h-full flex items-center justify-center bg-[var(--color-antigravity-bg)]">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-2 border-[var(--color-antigravity-accent)]/20 border-t-[var(--color-antigravity-accent)] rounded-full animate-spin" />
            <p className="text-zinc-600 font-mono text-[9px] uppercase tracking-[0.4em]">
              Syncing Context
            </p>
          </div>
        </div>
      );
    }

    if (activeMode === "tree" && data.treeRoot) {
      return <TreeView data={data.treeRoot} filter={filter} />;
    }
  };

  const isWideMode = chatWidth >= window.innerWidth - 10;

  return (
    <div
      id="workspace-viewport"
      className="h-screen w-screen bg-[var(--color-antigravity-bg)] text-[var(--color-antigravity-text-primary)] flex overflow-hidden font-sans pt-1"
    >
      {!isWideMode && (
        <section className="flex flex-col flex-1 min-h-0 relative">
          <header className="flex items-center gap-4 px-4 h-9 bg-[var(--color-antigravity-panel)]/40 backdrop-blur-xl border-b border-[var(--color-antigravity-border)] relative z-20">
            <div className="flex flex-1 items-center gap-2.5 bg-black/40 border border-[var(--color-antigravity-border)] rounded-lg px-3 h-6 focus-within:border-[var(--color-antigravity-accent)]/40 focus-within:bg-black/60 transition-all group/search">
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    const isShortUrl = /^[a-zA-Z0-9-]+\/[a-zA-Z0-9-_.]+$/.test(
                      repoUrl.trim(),
                    );
                    const isFullUrl = repoUrl.includes("github.com");

                    if ((isFullUrl || isShortUrl) && isWorkspaceEmpty) {
                      setShowCloneModal(true);
                    } else {
                      handleSearch(e as any);
                    }
                  }
                }}
                type="text"
                placeholder="github.com/owner/repo"
                className="flex-1 bg-transparent outline-none font-mono text-[11px] text-zinc-300 placeholder:text-zinc-800 h-full"
              />
            </div>

            <div
              className={`flex items-center gap-2 bg-black/40 border rounded-lg px-2.5 h-6 transition-all ${
                !repoUrl || data.error
                  ? "border-[var(--color-antigravity-border)] opacity-20 cursor-not-allowed"
                  : "border-zinc-800 focus-within:border-zinc-500"
              }`}
            >
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }}
                disabled={!repoUrl || !!data.error}
                type="text"
                placeholder="FILTER"
                className="bg-transparent disabled:cursor-not-allowed outline-none font-mono text-[10px] text-white placeholder:text-zinc-700 w-20 focus:w-44 transition-all h-full uppercase tracking-[0.2em]"
              />
            </div>

            <div className="relative group w-fit">
              <select
                value={activeMode}
                onChange={(e) => setActiveMode(e.target.value as any)}
                className="w-full min-w-[90px] max-w-[120px] bg-white/[0.03] border border-[var(--color-antigravity-border)] rounded-md px-2.5 pr-7 h-6 text-[10px] font-medium tracking-tight text-[var(--color-antigravity-text-secondary)] outline-none focus:border-[var(--color-antigravity-accent)]/50 appearance-none cursor-pointer transition-all hover:bg-white/[0.06] hover:text-[var(--color-antigravity-text-primary)] disabled:opacity-50 truncate"
              >
                <option value="tree" className="bg-zinc-950 text-zinc-300">Hierarchy</option>
                <option value="flow" className="bg-zinc-950 text-zinc-300">Analysis</option>
              </select>
              <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-30 group-hover:opacity-60 transition-opacity">
                <ChevronDown size={10} />
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setIsChatOpen(!isChatOpen)}
                className={`cursor-pointer shrink-0 flex items-center justify-center p-1.5 h-6 w-6 rounded-lg border transition-all ${
                  isChatOpen
                    ? "bg-black/40 border-[var(--color-antigravity-border)] text-zinc-600 hover:text-zinc-400"
                    : "bg-[var(--color-antigravity-accent)]/10 border-[var(--color-antigravity-accent)]/30 text-[var(--color-antigravity-accent)] shadow-[0_0_15px_rgba(59,130,246,0.1)]"
                }`}
                title="Toggle AI Chat"
              >
                <Cpu size={12} className={isChatOpen ? "" : "animate-pulse"} />
              </button>
            </div>
          </header>

          <div className="relative flex-1 min-h-0 bg-[var(--color-antigravity-bg)]/20">
            {renderWorkspaceState()}
          </div>
        </section>
      )}

      {isChatOpen && (
        <aside
          style={{ width: isWideMode ? "100%" : `${chatWidth}px` }}
          className={`shrink-0 h-full border-l border-[var(--color-antigravity-border)] animate-in slide-in-from-right duration-700 cubic-bezier(0.16, 1, 0.3, 1) shadow-[0_0_50px_rgba(0,0,0,0.4)] relative bg-[var(--color-antigravity-bg)] z-30 ${
            isWideMode ? "border-l-0" : ""
          }`}
        >
          {/* Neutral Stealth Resizer */}
          <div
            onMouseDown={startResizing}
            className="absolute left-[-4px] top-0 bottom-0 w-[8px] transition-all cursor-col-resize z-[100] group flex items-center justify-center"
          >
            <div
              className={`w-[1px] h-full transition-all duration-300 ${
                isResizing
                  ? "bg-[var(--color-antigravity-accent)]/40 w-[2px]"
                  : "bg-transparent group-hover:bg-[var(--color-antigravity-border)]"
              }`}
            />
          </div>

          <AiChat
            key={`ai-chat-${repoUrl || "initial"}`}
            repoData={data.fullRepoData || undefined}
          />
        </aside>
      )}

      {showCloneModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-300">
          <div className="bg-[var(--color-antigravity-panel)] border border-[var(--color-antigravity-border)] p-6 rounded-xl shadow-2xl w-[400px] animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded bg-[var(--color-antigravity-accent)]/10 text-[var(--color-antigravity-accent)]">
                <Cpu size={20} />
              </div>
              <h3 className="text-sm font-bold uppercase tracking-widest text-[var(--color-antigravity-text-primary)]">
                Initialize Workspace
              </h3>
            </div>

            <p className="text-[11px] text-zinc-500 mb-6 leading-relaxed">
              Detected a repository link. Would you like to{" "}
              <span className="text-zinc-300">clone and bootstrap</span> this
              project with Antigravity skills and workflows?
            </p>

            <div className="space-y-4">
              <div>
                <label className="text-[8px] text-zinc-700 uppercase tracking-widest block mb-1.5 ml-1">
                  Clone Path
                </label>
                <input
                  type="text"
                  value={clonePath}
                  onChange={(e) => setClonePath(e.target.value)}
                  className="w-full bg-black/40 border border-[var(--color-antigravity-border)] rounded px-3 py-2 text-[12px] text-zinc-300 outline-none focus:border-[var(--color-antigravity-accent)]/40 transition-all font-mono"
                  placeholder="./"
                />
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => {
                    handleSearch({ preventDefault: () => {} } as any);
                    setShowCloneModal(false);
                  }}
                  className="flex-1 px-4 py-2 rounded bg-white/5 hover:bg-white/10 text-[10px] text-zinc-400 uppercase tracking-widest transition-all border border-[var(--color-antigravity-border)]"
                >
                  Just Analyze
                </button>
                <button
                  onClick={() => {
                    setIsCloning(true);
                    let finalUrl = repoUrl.trim();
                    if (!finalUrl.includes("://")) {
                      finalUrl = `https://github.com/${finalUrl}`;
                    }
                    (window as any).vscode?.postMessage({
                      command: "cloneRepo",
                      url: finalUrl,
                      path: clonePath,
                    });
                  }}
                  disabled={isCloning}
                  className="flex-1 px-4 py-2 rounded bg-[var(--color-antigravity-accent)] hover:opacity-90 text-[10px] text-white font-bold uppercase tracking-widest transition-all shadow-lg shadow-blue-900/20 disabled:opacity-50"
                >
                  {isCloning ? "Cloning..." : "Clone & Boot"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
