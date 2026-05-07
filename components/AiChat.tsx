"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Cpu,
  Send,
  Loader2,
  Github,
  Square,
  Trash2,
  CheckCircle2,
  Circle,
  Eye,
  FileText,
  ChevronDown,
  ChevronUp,
  Beaker,
  Activity,
} from "lucide-react";
import { useSelectionStore } from "@/lib/core/store";
import { FullRepoData } from "@/lib/core/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface AiChatProps {
  repoData: FullRepoData;
}

const MarkdownRenderer = ({ content }: { content: string }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      p: ({ children }) => (
        <div className="mb-3 last:mb-0 leading-relaxed text-zinc-300">
          {children}
        </div>
      ),
      h1: ({ children }) => (
        <h1 className="font-bold text-base text-zinc-100 mt-6 mb-2 border-b border-zinc-800 pb-2">
          {children}
        </h1>
      ),
      h2: ({ children }) => (
        <h2 className="font-bold text-sm text-zinc-100 mt-5 mb-2 flex items-center gap-2">
          <div className="w-1 h-4 bg-zinc-500 rounded-full" />
          {children}
        </h2>
      ),
      h3: ({ children }) => (
        <h3 className="font-semibold text-[13px] text-zinc-200 mt-4 mb-1.5">
          {children}
        </h3>
      ),
      ul: ({ children }) => (
        <ul className="list-disc list-outside space-y-1.5 mb-4 ml-4 text-zinc-400">
          {children}
        </ul>
      ),
      ol: ({ children }) => (
        <ol className="list-decimal list-outside space-y-1.5 mb-4 ml-4 text-zinc-400">
          {children}
        </ol>
      ),
      li: ({ children }) => <li className="pl-1">{children}</li>,
      table: ({ children }) => (
        <div className="my-4 overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-left border-collapse text-[11px]">
            {children}
          </table>
        </div>
      ),
      thead: ({ children }) => (
        <thead className="bg-zinc-800/50 text-zinc-200 font-bold">
          {children}
        </thead>
      ),
      th: ({ children }) => (
        <th className="p-2 border-b border-zinc-700">{children}</th>
      ),
      td: ({ children }) => (
        <td className="p-2 border-b border-zinc-800 text-zinc-400">
          {children}
        </td>
      ),
      code: ({ inline, className, children }: any) => {
        const match = /language-(\w+)/.exec(className || "");
        const lang = match ? match[1] : "";

        return inline ? (
          <code className="bg-zinc-800/50 text-zinc-300 px-1.5 py-0.5 rounded text-[11px] font-mono border border-zinc-700/30">
            {children}
          </code>
        ) : (
          <div className="group relative my-3">
            {lang && (
              <div className="absolute right-3 top-2 text-[9px] font-mono text-zinc-500 uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity">
                {lang}
              </div>
            )}
            <pre className="bg-[#0d1117] border border-zinc-800 rounded-lg p-4 overflow-x-auto shadow-inner">
              <code className="text-[11px] text-zinc-100/90 whitespace-pre font-mono leading-relaxed">
                {children}
              </code>
            </pre>
          </div>
        );
      },
      strong: ({ children }) => (
        <strong className="text-zinc-100 font-bold">{children}</strong>
      ),
      em: ({ children }) => (
        <em className="text-zinc-200 italic font-medium">{children}</em>
      ),
      blockquote: ({ children }) => (
        <blockquote className="border-l-4 border-zinc-500/30 bg-zinc-500/5 px-4 py-2 my-4 text-zinc-400 italic rounded-r-lg">
          {children}
        </blockquote>
      ),
      a: ({ href, children }) => (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-zinc-400 hover:text-zinc-300 underline underline-offset-4 decoration-zinc-500/30 transition-colors"
        >
          {children}
        </a>
      ),
      hr: () => <hr className="border-zinc-800 my-6" />,
    }}
  >
    {content}
  </ReactMarkdown>
);

import { ChatStep, CombinedFile } from "@/lib/core/types";

const HistoryToggle = ({
  steps,
  files,
}: {
  steps: ChatStep[];
  files: CombinedFile[];
}) => {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="flex flex-col w-full">
      {(steps.length > 0 || files.length > 0) && (
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-1.5 text-[9px] font-bold text-zinc-500 uppercase tracking-widest hover:text-zinc-300 transition-colors py-1 group"
        >
          <span className="text-[10px] text-zinc-700">
            {isOpen ? "[-]" : "[+]"}
          </span>
          History
        </button>
      )}
      {isOpen && (steps.length > 0 || files.length > 0) && (
        <div className="border-l border-zinc-800 ml-1.5 pl-3 mb-2 animate-in fade-in slide-in-from-top-1 duration-200">
          <StepHistory steps={steps} />
          <CombinedFilesView files={files} />
        </div>
      )}
    </div>
  );
};

const StepHistory = ({ steps }: { steps: ChatStep[] }) => {
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

  const filtteredSteps = steps.filter(
    (s) => s.status === "done" || s.status === "error",
  );

  if (filtteredSteps.length > 0) {
    return (
      <div className="space-y-0.5 my-1 pt-1 w-full">
        <div className="space-y-0.5 pl-1">
          {filtteredSteps.map((step) => (
            <div key={step.id} className="flex flex-col">
              <div className="flex items-center justify-between py-0.5 group">
                <div className="flex items-center gap-2 overflow-hidden flex-1">
                  <span className="text-[10px] font-mono truncate text-zinc-500">
                    {step.label}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {step.output && (
                    <button
                      onClick={() =>
                        setExpandedStep(
                          expandedStep === step.id ? null : step.id,
                        )
                      }
                      className="text-zinc-600 hover:text-zinc-400 transition-colors"
                    >
                      {expandedStep === step.id ? (
                        <ChevronUp size={10} />
                      ) : (
                        <ChevronDown size={10} />
                      )}
                    </button>
                  )}
                </div>
              </div>
              {expandedStep === step.id && step.output && (
                <div className="py-1 px-1 mb-1 w-full animate-in fade-in zoom-in-95 duration-200">
                  <pre className="text-[9px] text-zinc-200 font-mono whitespace-pre-wrap overflow-x-auto max-h-[200px] pl-2 border-l border-zinc-800">
                    {step.output}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  } else return null;
};

const CombinedFilesView = ({ files }: { files: CombinedFile[] }) => {
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

  return (
    <div className="mt-2 pt-1 w-full">
      <div className="text-[9px] font-bold text-zinc-500 uppercase tracking-wider mb-1.5 px-1">
        Modified
      </div>
      <div className="space-y-0.5">
        {files.map((file) => (
          <div key={file.path} className="flex flex-col">
            <button
              onClick={() =>
                setExpandedFile(expandedFile === file.path ? null : file.path)
              }
              className="flex items-center justify-between py-0.5 group pl-1"
            >
              <div className="flex items-center gap-2 overflow-hidden">
                <span className="text-[10px] font-mono text-zinc-400 truncate">
                  {file.path.split("/").pop()}
                </span>
                <span className="text-[8px] text-zinc-600 font-mono uppercase tracking-tighter">
                  [{file.status}]
                </span>
              </div>
              <span className="text-[9px] text-zinc-700 font-mono group-hover:text-zinc-500">
                {expandedFile === file.path ? "[-]" : "[+]"}
              </span>
            </button>
            {expandedFile === file.path && (
              <div className="ml-1 pl-2 mb-1 w-full">
                <div className="py-1">
                  <div className="text-[8px] text-zinc-400 font-mono mb-0.5 uppercase tracking-widest italic">
                    Proposed
                  </div>
                  <pre className="text-[9px] text-zinc-100 font-mono whitespace-pre overflow-x-auto max-h-[150px]">
                    {file.coderContent || "// No content"}
                  </pre>
                </div>
                <div className="py-1 border-t border-zinc-800/20">
                  <div className="text-[8px] text-zinc-400 font-mono mb-0.5 uppercase tracking-widest italic">
                    Feedback
                  </div>
                  <div className="text-[9px] text-zinc-300 font-sans italic leading-tight">
                    {file.reviewerFeedback || "none"}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

const AiChat = ({ repoData }: AiChatProps) => {
  const dummySteps: ChatStep[] = [];

  const dummyFiles: CombinedFile[] = [];

  const [messages, setMessages] = useState<
    {
      role: string;
      content: string;
      streaming?: boolean;
      history?: ChatStep[];
      files?: CombinedFile[];
      isFinal?: boolean;
    }[]
  >([
    // Empty initially per user request
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [currentStatus, setCurrentStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
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
    setProgress(null);
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
      setCurrentStatus("Init Architect Engine...");
      setProgress(null);

      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          history: [],
          files: [],
        };
        return updated;
      });

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
            if (job.progress !== undefined) {
              setProgress(job.progress);
            } else {
              setProgress(null);
            }
            if (job.logs) {
              setLogs(job.logs);
            }

            if (job.partialResult || job.history || job.files) {
              setMessages((prev) => {
                const updated = [...prev];
                const lastIdx = updated.length - 1;
                updated[lastIdx] = {
                  ...updated[lastIdx],
                  content: job.partialResult ?? updated[lastIdx].content,
                  history: job.history ?? updated[lastIdx].history,
                  files: job.files ?? updated[lastIdx].files,
                  streaming: job.status !== "done" && job.status !== "error",
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
                const lastIdx = updated.length - 1;
                updated[lastIdx] = {
                  ...updated[lastIdx],
                  role: "assistant",
                  content: job.result,
                  streaming: false,
                  isFinal: true,
                  history: job.history ?? updated[lastIdx].history,
                  files: job.files ?? updated[lastIdx].files,
                };
                return updated;
              });
              setIsLoading(false);
              setCurrentStatus(null);
              setProgress(null);
              setLogs(null);
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
              setProgress(null);
              setLogs(null);
            }
          } catch (pollErr: any) {
            if (pollErr.name !== "AbortError") {
              console.error("Polling error:", pollErr);
              clearInterval(pollIntervalRef.current!);
              pollIntervalRef.current = null;
              abortControllerRef.current = null;
              setIsLoading(false);
              setCurrentStatus(null);
              setProgress(null);
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
          setProgress(null);
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
    <div className="w-[300px] shrink-0 flex flex-col bg-gray-900 border border-gray-700 rounded-xl overflow-hidden h-full shadow-2xl">
      <div className="px-3 py-2 border-b border-gray-700 flex items-center justify-between bg-gray-950/50">
        <div className="flex items-center gap-1.5">
          <Cpu size={12} className="text-zinc-500" />
          <span className="text-[11px] font-mono font-bold text-gray-400 uppercase tracking-widest pt-0.5">
            AI Agent
          </span>
        </div>
        <span className="flex items-center gap-1 text-[11px] font-mono text-zinc-400 truncate max-w-[180px] border border-gray-700 py-0.5 px-2 rounded-full">
          <Github size={11} className="shrink-0 text-purple-400" />
          {repoName}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-xs font-mono text-zinc-600 text-center mt-6 leading-relaxed">
            Ask anything about this repo.
          </p>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex flex-col w-full ${msg.role === "user" ? "items-end" : "items-start"}`}
          >
            <div
              className={`w-full py-1 text-xs leading-relaxed overflow-auto ${
                msg.role === "user"
                  ? "bg-blue-600/10 border border-blue-500/20 text-blue-100 whitespace-pre-wrap p-2 rounded-lg ml-auto max-w-[90%]"
                  : "text-zinc-400"
              }`}
            >
              {msg.role === "assistant" ? (
                <div className="flex flex-col gap-1">
                  <div className="flex flex-col">
                    {msg.isFinal ? (
                      <>
                        <HistoryToggle
                          steps={msg.history || []}
                          files={msg.files || []}
                        />
                        {msg.content !== "" && (
                          <MarkdownRenderer content={msg.content} />
                        )}
                      </>
                    ) : (
                      <>
                        {msg.history && msg.history.length > 0 && (
                          <StepHistory steps={msg.history} />
                        )}
                        {msg.files && msg.files.length > 0 && (
                          <CombinedFilesView files={msg.files} />
                        )}
                        {msg.content !== "" && (
                          <MarkdownRenderer content={msg.content} />
                        )}

                        {msg.streaming && (
                          <div className="flex flex-col gap-1.5 mt-1 pt-1.5">
                            <div className="flex items-center gap-1.5 text-zinc-500">
                              <Loader2
                                size={10}
                                className="animate-spin text-zinc-500 shrink-0"
                              />
                              <span className="text-[11px] animate-pulse truncate text-zinc-400">
                                {currentStatus ||
                                  (msg.content === ""
                                    ? "Initializing..."
                                    : "Generating...")}
                              </span>
                            </div>
                            {progress !== null && (
                              <div className="h-1 w-full bg-zinc-800 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-zinc-500 transition-all duration-300 ease-out"
                                  style={{ width: `${progress}%` }}
                                />
                              </div>
                            )}
                            {logs && (
                              <div className="mt-1">
                                <button
                                  onClick={() => setShowLogs(!showLogs)}
                                  className="text-[9px] text-zinc-600 hover:text-zinc-400 uppercase font-bold tracking-tighter"
                                >
                                  {showLogs ? "Hide Logs" : "Show Logs"}
                                </button>
                                {showLogs && (
                                  <pre className="mt-1 p-2 bg-black/40 rounded border border-zinc-800/50 text-[9px] text-zinc-500 font-mono overflow-x-auto max-h-[150px] whitespace-pre-wrap">
                                    {logs}
                                  </pre>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ) : (
                msg.content
              )}
            </div>
          </div>
        ))}

        <div ref={messagesEndRef} />
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
            placeholder={isLoading ? "Generating..." : "Ask about this repo..."}
            className="w-full bg-gray-950 border border-gray-700 text-xs font-mono text-zinc-300 pl-3 pr-8 py-2.5 rounded-lg outline-none focus:border-zinc-500/40 transition-all disabled:opacity-50"
          />
          {isLoading ? (
            <button
              type="button"
              onClick={handleStop}
              title="Stop"
              className="absolute right-2.5 top-3.5 text-red-400 hover:text-red-300 transition-colors"
            >
              <Square size={12} className="fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="absolute right-2.5 top-3.5 text-gray-500 hover:text-zinc-400 disabled:hover:text-gray-500 disabled:opacity-30 transition-colors"
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
