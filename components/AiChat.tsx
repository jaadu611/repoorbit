"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Cpu, Send, Loader2, Github, Square, Trash2 } from "lucide-react";
import { useSelectionStore } from "@/lib/store";
import { FullRepoData } from "@/lib/types";
import ReactMarkdown from "react-markdown";

interface AiChatProps {
  repoData: FullRepoData;
}

const MarkdownRenderer = ({ content }: { content: string }) => (
  <ReactMarkdown
    components={{
      p: ({ children }) => (
        <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>
      ),
      h1: ({ children }) => (
        <h1 className="font-bold text-[11px] text-slate-100 mt-3 mb-1 border-b border-slate-700 pb-1">
          {children}
        </h1>
      ),
      h2: ({ children }) => (
        <h2 className="font-bold text-[11px] text-slate-100 mt-3 mb-1">
          {children}
        </h2>
      ),
      h3: ({ children }) => (
        <h3 className="font-semibold text-[10px] text-slate-200 mt-2 mb-1">
          {children}
        </h3>
      ),
      ul: ({ children }) => (
        <ul className="list-disc list-inside space-y-0.5 mb-2 pl-1">
          {children}
        </ul>
      ),
      ol: ({ children }) => (
        <ol className="list-decimal list-inside space-y-0.5 mb-2 pl-1">
          {children}
        </ol>
      ),
      li: ({ children }) => (
        <li className="text-slate-300 leading-relaxed">{children}</li>
      ),
      code: ({ inline, children }: any) =>
        inline ? (
          <code className="bg-slate-800 text-blue-300 px-1 py-0.5 rounded text-[9px] font-mono">
            {children}
          </code>
        ) : (
          <pre className="bg-slate-800/80 border border-slate-700 rounded p-2 mt-1 mb-2 overflow-x-auto">
            <code className="text-[9px] text-blue-200 whitespace-pre font-mono">
              {children}
            </code>
          </pre>
        ),
      strong: ({ children }) => (
        <strong className="text-slate-100 font-semibold">{children}</strong>
      ),
      em: ({ children }) => (
        <em className="text-slate-300 italic">{children}</em>
      ),
      blockquote: ({ children }) => (
        <blockquote className="border-l-2 border-blue-500/50 pl-2 my-1 text-slate-400 italic">
          {children}
        </blockquote>
      ),
      a: ({ href, children }) => (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
        >
          {children}
        </a>
      ),
      hr: () => <hr className="border-slate-700 my-2" />,
    }}
  >
    {content}
  </ReactMarkdown>
);

const AiChat = ({ repoData }: AiChatProps) => {
  const [messages, setMessages] = useState<
    { role: string; content: string; streaming?: boolean }[]
  >([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [currentStatus, setCurrentStatus] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { repoContext: repoCtx } = useSelectionStore((s) => s.selection);
  const setRepoContext = useSelectionStore((s) => s.setRepoContext);

  useEffect(() => {
    if (repoData.repoContext) setRepoContext(repoData.repoContext);
  }, [repoData.repoContext, setRepoContext]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const stopAll = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsLoading(false);
    setCurrentStatus(null);
    setMessages((prev) =>
      prev.map((m, i) =>
        i === prev.length - 1 && m.streaming ? { ...m, streaming: false } : m,
      ),
    );
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
        { role: "assistant", content: "", streaming: true },
      ]);
      setIsLoading(true);
      setCurrentStatus("Starting architect engine...");

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
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

            if (job.statusText) {
              setCurrentStatus(job.statusText);
            }

            if (job.partialResult) {
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  content: job.partialResult,
                  streaming: true,
                };
                return updated;
              });
            }

            if (job.status === "done") {
              clearInterval(pollIntervalRef.current!);
              pollIntervalRef.current = null;
              abortControllerRef.current = null;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: job.result,
                  streaming: false,
                };
                return updated;
              });
              setIsLoading(false);
              setCurrentStatus(null);
            } else if (job.status === "error") {
              clearInterval(pollIntervalRef.current!);
              pollIntervalRef.current = null;
              abortControllerRef.current = null;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: `**Error:** ${job.error || "Generation failed"}`,
                  streaming: false,
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
        }, 1000);
      } catch (err: any) {
        if (err?.name !== "AbortError") {
          abortControllerRef.current = null;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: `**Error:** ${err.message}`,
              streaming: false,
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

  const handleStop = () => stopAll();
  const handleClear = () => {
    if (isLoading) handleStop();
    setMessages([]);
  };

  const repoName = repoCtx?.meta.name ?? repoData.metadata.name;

  return (
    <div className="w-72 shrink-0 flex flex-col bg-gray-900 border border-gray-700 rounded-xl overflow-hidden h-full shadow-2xl">
      {/* Header */}
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

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-[10px] font-mono text-slate-600 text-center mt-6 leading-relaxed">
            Ask anything about this repo.
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
              {msg.role === "assistant" ? (
                <div className="flex flex-col gap-1">
                  {/* Empty + loading = show spinner */}
                  {msg.content === "" && msg.streaming ? (
                    <div className="flex items-center gap-2 text-slate-400">
                      <Loader2
                        size={11}
                        className="animate-spin text-blue-500"
                      />
                      <span className="animate-pulse">
                        {currentStatus || "Thinking..."}
                      </span>
                    </div>
                  ) : (
                    <>
                      {/* Live markdown render — updates as partialResult grows */}
                      <MarkdownRenderer content={msg.content} />

                      {/* Status bar shown while streaming */}
                      {msg.streaming && (
                        <div className="flex items-center gap-1.5 text-slate-500 mt-1 border-t border-slate-800/50 pt-1.5">
                          <Loader2
                            size={10}
                            className="animate-spin text-blue-500/70 shrink-0"
                          />
                          <span className="text-[9px] animate-pulse truncate">
                            {currentStatus || "Generating..."}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : (
                msg.content
              )}
            </div>
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
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
            placeholder={isLoading ? "Generating..." : "Ask about this repo..."}
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
