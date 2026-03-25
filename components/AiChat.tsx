"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Cpu, Send, Loader2, Github, Square, Trash2 } from "lucide-react";
import { useSelectionStore } from "@/lib/store";
import { FullRepoData } from "@/lib/types";
import ReactMarkdown from "react-markdown";

interface AiChatProps {
  repoData: FullRepoData;
}

const AiChat = ({ repoData }: AiChatProps) => {
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [currentStatus, setCurrentStatus] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { repoContext: repoCtx } = useSelectionStore((s) => s.selection);
  const setRepoContext = useSelectionStore((s) => s.setRepoContext);

  useEffect(() => {
    if (repoData.repoContext) setRepoContext(repoData.repoContext);
  }, [repoData.repoContext, setRepoContext]);

  const stopAll = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsLoading(false);
    setCurrentStatus(null);
  }, []);

  const handleSend = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const userMessage = input.trim();
      if (!userMessage || isLoading) return;

      setInput("");
      setMessages((prev) => [
        ...prev,
        { role: "user", content: userMessage },
        { role: "assistant", content: "" },
      ]);
      setIsLoading(true);
      setCurrentStatus("Starting architect engine...");

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        // 1. Start the Job
        const startResponse = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: userMessage,
            repoContext: repoCtx ?? repoData.repoContext,
            owner: repoData.metadata.owner,
            repo: repoData.metadata.name,
            tree: repoData.tree,
            defaultBranch: repoData.metadata.defaultBranch,
          }),
          signal: controller.signal,
        });

        if (!startResponse.ok) {
          const data = await startResponse.json();
          throw new Error(data.error || "API error");
        }

        const { taskId } = await startResponse.json();

        // 2. Poll for Completion
        pollIntervalRef.current = setInterval(async () => {
          if (controller.signal.aborted) {
            clearInterval(pollIntervalRef.current!);
            pollIntervalRef.current = null;
            return;
          }

          try {
            const pollResponse = await fetch(`/api/chat?taskId=${taskId}`, {
              signal: controller.signal,
            });
            const job = await pollResponse.json();

            // Show real automator milestone if available
            if (job.statusText) {
              setCurrentStatus(job.statusText);
            }

            if (job.status === "done") {
              clearInterval(pollIntervalRef.current!);
              pollIntervalRef.current = null;
              abortControllerRef.current = null;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  content: job.result,
                };
                return updated;
              });
              setIsLoading(false);
              setCurrentStatus(null);
            } else if (job.status === "error") {
              clearInterval(pollIntervalRef.current!);
              pollIntervalRef.current = null;
              abortControllerRef.current = null;
              const errMsg = job.error || "Generation failed";
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: `⚠️ Error: ${errMsg}`,
                };
                return updated;
              });
              setIsLoading(false);
              setCurrentStatus(null);
            }
          } catch (pollErr: any) {
            if (pollErr.name !== "AbortError") {
              console.error("Polling error:", pollErr);
              clearInterval(pollIntervalRef.current!);
              pollIntervalRef.current = null;
              abortControllerRef.current = null;
              setIsLoading(false);
              setCurrentStatus(null);
            }
          }
        }, 3000);

      } catch (err: any) {
        if (err?.name !== "AbortError") {
          abortControllerRef.current = null;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: `⚠️ Error: ${err.message}`,
            };
            return updated;
          });
          setIsLoading(false);
          setCurrentStatus(null);
        }
      }
    },
    [input, isLoading, repoCtx, repoData, stopAll],
  );

  const handleStop = () => {
    stopAll();
  };

  const handleClear = () => {
    if (isLoading) handleStop();
    setMessages([]);
  };

  const repoName = repoCtx?.meta.name ?? repoData.metadata.name;

  return (
    <div className="w-72 shrink-0 flex flex-col bg-gray-900 border border-gray-700 rounded-xl overflow-hidden h-full shadow-2xl">
      <div className="px-3 py-2 border-b border-gray-700 flex items-center justify-between bg-gray-950/50">
        <div className="flex items-center gap-1.5">
          <Cpu size={12} className="text-blue-500" />
          <span className="text-[9px] font-mono font-bold text-gray-400 uppercase tracking-widest pt-0.5">
            AI Agent
          </span>
        </div>
        <span className="flex items-center gap-1 text-[10px] font-mono text-slate-400 truncate max-w-[130px] border border-gray-700 py-0.5 px-2 rounded-full">
          <Github size={11} className="shrink-0 text-purple-400" />
          {repoName}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-[10px] font-mono text-slate-600 text-center mt-6 leading-relaxed">
            Generate NotebookLM context here.
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
          >
            <div
              className={`max-w-[92%] p-2.5 rounded-lg text-[10px] font-mono leading-relaxed overflow-auto ${
                msg.role === "user"
                  ? "bg-blue-600/10 border border-blue-500/20 text-blue-100 whitespace-pre-wrap"
                  : "bg-slate-900/50 border border-slate-800 text-slate-300"
              }`}
            >
              {msg.role === "assistant" && msg.content === "" && isLoading ? (
                <div className="flex items-center gap-2 text-slate-400">
                  <Loader2 size={11} className="animate-spin text-blue-500" />
                  <span className="animate-pulse">{currentStatus || "Thinking..."}</span>
                </div>
              ) : msg.role === "assistant" ? (
                <ReactMarkdown
                  components={{
                    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                    h1: ({ children }) => <h1 className="font-bold text-[11px] text-slate-100 mt-3 mb-1">{children}</h1>,
                    h2: ({ children }) => <h2 className="font-bold text-[11px] text-slate-100 mt-3 mb-1">{children}</h2>,
                    h3: ({ children }) => <h3 className="font-semibold text-[10px] text-slate-200 mt-2 mb-1">{children}</h3>,
                    ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 mb-2 pl-1">{children}</ul>,
                    ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 mb-2 pl-1">{children}</ol>,
                    li: ({ children }) => <li className="text-slate-300">{children}</li>,
                    code: ({ inline, children }: any) =>
                      inline ? (
                        <code className="bg-slate-800 text-blue-300 px-1 py-0.5 rounded text-[9px]">{children}</code>
                      ) : (
                        <pre className="bg-slate-800/80 border border-slate-700 rounded p-2 mt-1 mb-2 overflow-x-auto">
                          <code className="text-[9px] text-blue-200 whitespace-pre">{children}</code>
                        </pre>
                      ),
                    strong: ({ children }) => <strong className="text-slate-100 font-semibold">{children}</strong>,
                    blockquote: ({ children }) => (
                      <blockquote className="border-l-2 border-blue-500/50 pl-2 my-1 text-slate-400 italic">{children}</blockquote>
                    ),
                  }}
                >
                  {msg.content as string}
                </ReactMarkdown>
              ) : (
                msg.content
              )}
            </div>
          </div>
        ))}
      </div>

      <form
        onSubmit={handleSend}
        className="p-2.5 bg-gray-950 border-t border-gray-700 flex items-center gap-2"
      >
        {messages.length > 0 && !isLoading && (
          <button
            type="button"
            onClick={handleClear}
            title="Clear chat"
            className="shrink-0 w-8 h-8 flex items-center justify-center text-gray-600 hover:text-red-400 border border-gray-800 rounded-lg hover:bg-red-400/5 transition-all"
          >
            <Trash2 size={14} />
          </button>
        )}
        <div className="relative flex-1">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isLoading}
            placeholder={isLoading ? "Generating context..." : "Ask to generate context..."}
            className="w-full bg-gray-950 border border-gray-700 text-[10px] font-mono text-slate-300 pl-3 pr-8 py-2 rounded-lg outline-none focus:border-blue-500/40 transition-all disabled:opacity-50"
          />
          {isLoading ? (
            <button
              type="button"
              onClick={handleStop}
              title="Stop"
              className="absolute right-2.5 top-[10px] text-red-400 hover:text-red-300 transition-colors"
            >
              <Square size={12} className="fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="absolute right-2.5 top-[10px] text-gray-500 hover:text-blue-400 disabled:hover:text-gray-500 disabled:opacity-30 transition-colors"
            >
              <Send size={12} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

export default AiChat;
