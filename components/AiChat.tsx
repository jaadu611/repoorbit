import { useState, useRef, useEffect } from "react";
import {
  Bot,
  RefreshCw,
  ChevronDown,
  Play,
  Pause,
  FileText,
  Trash2,
} from "lucide-react";
import { useSelectionStore } from "@/lib/core/store";
import { FullRepoData } from "@/lib/core/types";
import { SYSTEM_PROMPT } from "@/src/lib/core/prompt";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  steps?: any[];
}

interface AiChatProps {
  repoData?: FullRepoData;
}

// AiChat.tsx
// AiChat.tsx
const MarkdownRenderer = ({ content }: { content: string }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      p: ({ children }) => (
        <div className="mb-2 last:mb-0 leading-relaxed text-[var(--color-antigravity-text-secondary)] text-[11px]">
          {children}
        </div>
      ),
      h1: ({ children }) => (
        <h1 className="font-bold text-[13px] text-[var(--color-antigravity-text-primary)] mt-4 mb-2">
          {children}
        </h1>
      ),
      h2: ({ children }) => (
        <h2 className="font-bold text-[11px] text-[var(--color-antigravity-text-primary)] mt-4 mb-1 opacity-90">
          {children}
        </h2>
      ),
      ul: ({ children }) => (
        <ul className="list-disc list-outside space-y-1 mb-3 ml-4 text-[var(--color-antigravity-text-secondary)] text-[11px]">
          {children}
        </ul>
      ),
      code: ({ inline, className, children }: any) => {
        const match = /language-(\w+)/.exec(className || "");
        const lang = match ? match[1] : "text";
        const content = String(children).replace(/\n$/, "");
        const isLong = content.includes("\n") || content.length > 40;

        if (inline || !isLong) {
          return (
            <code className="bg-white/5 text-[var(--color-antigravity-accent)] px-1.5 py-0.5 rounded text-[10px] font-mono border border-white/5 inline-block my-0.5 align-middle opacity-90">
              {content}
            </code>
          );
        }

        return (
          <div className="my-4 group/code relative rounded-lg border border-[var(--color-antigravity-border)] bg-[var(--color-antigravity-code-bg)] overflow-hidden shadow-2xl">
            {/* Code Header */}
            <div className="flex items-center justify-between px-3 py-1.5 bg-white/5 border-b border-[var(--color-antigravity-border)] select-none">
              <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest">
                {lang}
              </span>
              <button
                onClick={() => navigator.clipboard.writeText(content)}
                className="p-1 hover:bg-white/10 rounded transition-colors text-zinc-500 hover:text-zinc-300"
                title="Copy code"
              >
                <svg
                  className="w-3 h-3"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
              </button>
            </div>
            <pre className="p-4 overflow-x-auto bg-[var(--color-antigravity-code-bg)]">
              <code className="text-[10px] text-[var(--color-antigravity-text-primary)] opacity-80 whitespace-pre font-mono leading-relaxed bg-transparent p-0 block">
                {children}
              </code>
            </pre>
          </div>
        );
      },
    }}
  >
    {content}
  </ReactMarkdown>
);

const AiChat = ({ repoData }: AiChatProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const [availableModels, setAvailableModels] = useState<
    {
      id: string;
      name: string;
      vendor?: string;
      quota?: string | number;
      resetTime?: string;
    }[]
  >([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFallback, setIsFallback] = useState(false);

  const [exhaustedModels, setExhaustedModels] = useState<Set<string>>(
    new Set(),
  );
  const [config, setConfig] = useState({
    model: "MODEL_PLACEHOLDER_M84",
  });

  const [loadedQueries, setLoadedQueries] = useState<string[]>([]);
  const [currentQueryIndex, setCurrentQueryIndex] = useState<number>(-1);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [queriesFileExists, setQueriesFileExists] = useState<boolean>(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { repoContext: repoCtx } = useSelectionStore((s) => s.selection);

  // Trigger next query in automated execution list
  useEffect(() => {
    if (!isPlaying || isLoading) return;

    // Previous query has finished (isLoading became false)
    // Check if there are more queries to run
    const nextIndex = currentQueryIndex + 1;
    if (nextIndex < loadedQueries.length) {
      const timer = setTimeout(() => {
        const query = loadedQueries[nextIndex];
        const combinedQuery = `${SYSTEM_PROMPT}\n\n${query}`;

        setMessages((prev) => [
          ...prev,
          { role: "user", content: query },
          { role: "assistant", content: "" },
        ]);
        setIsLoading(true);
        setCurrentQueryIndex(nextIndex);

        const vscodeApi = (window as any).vscode;
        if (vscodeApi) {
          vscodeApi.postMessage({
            command: "chat",
            query: combinedQuery,
            repoContext: repoCtx ?? repoData?.repoContext,
            config,
          });
        }
      }, 800); // 800ms delay between queries for visual flow

      return () => clearTimeout(timer);
    } else {
      // All queries processed!
      setIsPlaying(false);
    }
  }, [
    isPlaying,
    isLoading,
    currentQueryIndex,
    loadedQueries,
    repoCtx,
    repoData,
    config,
  ]);

  const handleCreateQueriesFile = () => {
    const vscodeApi = (window as any).vscode;
    if (vscodeApi) {
      vscodeApi.postMessage({ command: "createQueriesFile" });
    }
  };

  useEffect(() => {
    const vscodeApi = (window as any).vscode;
    if (vscodeApi) {
      vscodeApi.postMessage({ command: "readQueriesFile" });
      const timer = setInterval(() => {
        vscodeApi.postMessage({ command: "readQueriesFile" });
      }, 3000);
      return () => clearInterval(timer);
    }
  }, []);

  const handlePlayPause = () => {
    if (loadedQueries.length === 0) return;

    if (isPlaying) {
      setIsPlaying(false);
    } else {
      let startIndex = currentQueryIndex + 1;
      if (startIndex >= loadedQueries.length || startIndex < 0) {
        startIndex = 0;
      }

      setIsPlaying(true);

      const query = loadedQueries[startIndex];
      const combinedQuery = `${SYSTEM_PROMPT}\n\n${query}`;

      setMessages((prev) => [
        ...prev,
        { role: "user", content: query },
        { role: "assistant", content: "" },
      ]);
      setIsLoading(true);
      setCurrentQueryIndex(startIndex);

      const vscodeApi = (window as any).vscode;
      if (vscodeApi) {
        vscodeApi.postMessage({
          command: "chat",
          query: combinedQuery,
          repoContext: repoCtx ?? repoData?.repoContext,
          config,
        });
      }
    }
  };

  const handleClearChat = () => {
    setMessages([]);
    setIsPlaying(false);
    setCurrentQueryIndex(-1);
    setIsLoading(false);
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  const refreshModels = () => {
    const vscodeApi = (window as any).vscode;
    if (vscodeApi) {
      setIsRefreshing(true);
      vscodeApi.postMessage({ command: "getModels" });
      // Reset timeout
      setTimeout(() => setIsRefreshing(false), 3000);
    }
  };

  // Handle incoming messages from the VS Code host
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (
        message.command === "chatResponse" ||
        message.command === "chatStream"
      ) {
        setMessages((prev) => {
          const lastMsg = prev[prev.length - 1];
          if (lastMsg && lastMsg.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              {
                role: "assistant",
                content: message.text,
                steps: message.steps,
              },
            ];
          }
          return [
            ...prev,
            { role: "assistant", content: message.text, steps: message.steps },
          ];
        });
        if (message.command === "chatResponse") {
          setIsLoading(false);
        }
      } else if (message.command === "chatError") {
        setMessages((prev) => {
          const lastMsg = prev[prev.length - 1];
          if (
            lastMsg &&
            lastMsg.role === "assistant" &&
            lastMsg.content === ""
          ) {
            return [
              ...prev.slice(0, -1),
              { role: "assistant", content: `**Error:** ${message.text}` },
            ];
          }
          return [
            ...prev,
            { role: "assistant", content: `**Error:** ${message.text}` },
          ];
        });
        if (
          message.text.toLowerCase().includes("exhausted") ||
          message.text.toLowerCase().includes("quota")
        ) {
          setExhaustedModels((prev) => new Set(prev).add(config.model));
        }
        setIsLoading(false);
      } else if (message.command === "setModels") {
        const models = message.models || [];
        setAvailableModels(models);
        setIsRefreshing(false);
        setIsFallback(!!message.isFallback);

        if (models.length > 0) {
          setConfig((prev) => {
            const currentExists = models.some((m: any) => m.id === prev.model);
            if (
              !prev.model ||
              !currentExists ||
              prev.model === "MODEL_PLACEHOLDER_M84"
            ) {
              const geminiFlash = models.find(
                (m: any) =>
                  m.id === "MODEL_PLACEHOLDER_M84" ||
                  m.name.toLowerCase().includes("flash"),
              );
              return { ...prev, model: geminiFlash?.id || models[0].id };
            }
            return prev;
          });
        }
      } else if (message.command === "queriesFileResponse") {
        setQueriesFileExists(message.exists);
        setLoadedQueries(message.queries || []);
      }
    };

    window.addEventListener("message", handler);
    refreshModels();

    return () => window.removeEventListener("message", handler);
  }, [config.model]);

  return (
    <div className="w-full flex flex-col bg-[var(--color-antigravity-bg)] h-full overflow-hidden">
      {/* Top Part: Only bottom border, no side/top borders as main wrapper handled it */}
      <div className="flex-none bg-[var(--color-antigravity-panel)]/40 border-b border-[var(--color-antigravity-border)] relative z-10">
        <div className="px-3 h-[35px] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="relative group w-fit">
              <select
                value={config.model}
                onChange={(e) =>
                  setConfig({ ...config, model: e.target.value })
                }
                className="w-full min-w-[90px] max-w-[180px] bg-white/[0.03] border border-[var(--color-antigravity-border)] rounded-md px-2.5 pr-7 h-6 text-[10px] font-medium tracking-tight text-[var(--color-antigravity-text-secondary)] outline-none focus:border-[var(--color-antigravity-accent)]/50 appearance-none cursor-pointer transition-all hover:bg-white/[0.06] hover:text-[var(--color-antigravity-text-primary)] disabled:opacity-50 truncate"
                disabled={availableModels.length === 0}
              >
                {availableModels.length === 0 ? (
                  <option disabled>Engines offline...</option>
                ) : (
                  availableModels.map((model) => {
                    const formatQuota = (q: any) => {
                      const num = Number(q);
                      if (!isNaN(num)) return ` (${(num * 100).toFixed(0)}%)`;
                      return "";
                    };
                    return (
                      <option
                        key={model.id}
                        value={model.id}
                        className="bg-zinc-900 text-zinc-300"
                      >
                        {model.name}
                        {formatQuota(model.quota)}
                      </option>
                    );
                  })
                )}
              </select>
              <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-30 group-hover:opacity-60 transition-opacity">
                <ChevronDown size={10} />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={handleClearChat}
              className="p-1.5 rounded-md text-[var(--color-antigravity-text-secondary)] hover:text-[var(--color-antigravity-text-primary)] hover:bg-white/[0.05] transition-all"
              title="Clear Chat History"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar bg-[var(--color-antigravity-bg)]/30">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full opacity-[0.03] select-none pointer-events-none">
            <Bot size={56} strokeWidth={0.5} />
            <p className="text-[9px] font-mono mt-4 tracking-[0.5em] uppercase">
              Neural Link Ready
            </p>
          </div>
        )}

        <div className="flex flex-col">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`border-b border-white/[0.02] transition-colors duration-500 ${msg.role === "user" ? "bg-white/[0.015]" : "bg-transparent hover:bg-white/[0.005]"}`}
            >
              <div className="px-4 py-3.5 max-w-full">
                <div className="text-[11.5px] text-[var(--color-antigravity-text-primary)]/90 leading-[1.6] font-normal selection:bg-[var(--color-antigravity-accent)]/20">
                  {msg.role === "assistant" &&
                  (!msg.content || (isLoading && i === messages.length - 1)) ? (
                    <div className="py-2 px-3 bg-white/[0.02] border border-white/[0.05] rounded-lg relative overflow-hidden group/loading">
                      {/* Neural Pulse Scanning Effect */}
                      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-[var(--color-antigravity-accent)]/5 to-transparent -translate-x-full animate-[scan_2s_ease-in-out_infinite]" />

                      <div className="flex flex-col gap-1.5 relative z-10">
                        <div className="font-mono text-[10px] text-[var(--color-antigravity-text-secondary)]/60 flex items-center gap-2 overflow-hidden whitespace-nowrap">
                          <span className="opacity-40 shrink-0">[$]</span>
                          <span className="truncate">
                            {msg.steps && msg.steps.length > 0
                              ? msg.steps[msg.steps.length - 1]?.plannerResponse
                                  ?.thinking || "Executing logic flow..."
                              : "Initializing context engine..."}
                          </span>
                          <span className="animate-pulse">_</span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <MarkdownRenderer content={msg.content} />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div ref={messagesEndRef} className="h-4" />
      </div>

      <div className="w-full bg-[var(--color-antigravity-panel)]/40 backdrop-blur-xl border-t border-[var(--color-antigravity-border)] flex flex-col relative z-20">
        {/* Progress Bar (0 height, overlayed at the very top of input area) */}
        {queriesFileExists && loadedQueries.length > 0 && (
          <div className="absolute top-0 left-0 right-0 h-[2px] bg-white/[0.03]">
            <div
              className="h-full bg-[var(--color-antigravity-accent)] transition-all duration-500"
              style={{
                width: `${
                  loadedQueries.length > 0
                    ? ((currentQueryIndex >= 0 ? currentQueryIndex + 1 : 0) /
                        loadedQueries.length) *
                      100
                    : 0
                }%`,
              }}
            />
          </div>
        )}

        <div className="p-1.5 flex items-center gap-1.5 w-full">
          {/* Permanent File Indicator / Action Wrapper */}
          <div
            onClick={queriesFileExists ? undefined : handleCreateQueriesFile}
            className={`flex-1 flex items-center justify-between bg-white/[0.02] border border-[var(--color-antigravity-border)] rounded-md px-2 py-1 h-[28px] transition-all min-w-0 ${
              queriesFileExists
                ? ""
                : "hover:bg-white/[0.05] hover:border-[var(--color-antigravity-accent)]/30 cursor-pointer"
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <FileText
                size={12}
                className="text-[var(--color-antigravity-text-secondary)] opacity-60 shrink-0"
              />
              <span className="text-[10px] font-medium text-[var(--color-antigravity-text-secondary)] truncate">
                {queriesFileExists
                  ? ".repoorbit/queries.md"
                  : ".repoorbit/queries.md (Deleted)"}
              </span>
              {queriesFileExists && loadedQueries.length > 0 && (
                <span className="text-[9px] text-[var(--color-antigravity-text-secondary)] opacity-40 shrink-0 font-mono">
                  ({currentQueryIndex >= 0 ? currentQueryIndex + 1 : 0}/
                  {loadedQueries.length})
                </span>
              )}
            </div>

            {queriesFileExists ? (
              <span className="text-[9px] text-[var(--color-antigravity-text-secondary)] opacity-60 font-mono shrink-0">
                Queries: {loadedQueries.length}
              </span>
            ) : (
              <span className="text-[9px] text-[var(--color-antigravity-accent)] font-mono shrink-0 hover:text-[var(--color-antigravity-text-primary)]">
                Restore File
              </span>
            )}
          </div>

          {/* Play/Pause Button */}
          <button
            onClick={handlePlayPause}
            disabled={!queriesFileExists || loadedQueries.length === 0}
            className={`h-[28px] px-2.5 rounded-md border transition-all flex items-center justify-center shrink-0 ${
              !queriesFileExists || loadedQueries.length === 0
                ? "bg-white/[0.01] border-white/[0.02] text-white/10 cursor-not-allowed"
                : isPlaying
                  ? "bg-white/[0.06] border-[var(--color-antigravity-border)] text-[var(--color-antigravity-text-primary)] hover:bg-white/[0.1]"
                  : "bg-white/[0.02] border-[var(--color-antigravity-border)] text-[var(--color-antigravity-text-secondary)] hover:text-[var(--color-antigravity-text-primary)] hover:bg-white/[0.05]"
            }`}
            title={isPlaying ? "Pause execution" : "Start playing queries"}
          >
            {isPlaying ? (
              <Pause size={12} className="fill-current" />
            ) : (
              <Play size={12} className="fill-current ml-0.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AiChat;
