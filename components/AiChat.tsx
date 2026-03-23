"use client";

import { useState, useRef, useEffect, useCallback, ReactNode } from "react";
import { Cpu, Send, Loader2, Github, Square, Trash2 } from "lucide-react";
import { useSelectionStore } from "@/lib/store";
import { FullRepoData } from "@/lib/types";

interface AiChatProps {
  repoData: FullRepoData;
}

type IndexStatus = "idle" | "indexing" | "embedding" | "ready" | "failed";

const AiChat = ({ repoData }: AiChatProps) => {
  const [messages, setMessages] = useState<
    { role: string; content: ReactNode }[]
  >([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [indexStatus, setIndexStatus] = useState<IndexStatus>("idle");
  const [indexProgress, setIndexProgress] = useState(0);
  const [embeddingProgress, setEmbeddingProgress] = useState(0);
  const [embeddingTotal, setEmbeddingTotal] = useState(0);

  const abortControllerRef = useRef<AbortController | null>(null);

  const { repoContext: repoCtx } = useSelectionStore((s) => s.selection);
  const setRepoContext = useSelectionStore((s) => s.setRepoContext);
  const addFileMetadata = useSelectionStore((s) => s.addFileMetadata);
  const filesMetadata = useSelectionStore((s) => s.filesMetadata);

  useEffect(() => {
    if (repoData.repoContext) setRepoContext(repoData.repoContext);
  }, [repoData.repoContext, setRepoContext]);

  useEffect(() => {
    if (!repoData.tree?.length || indexStatus !== "idle") return;

    const startIndexing = async () => {
      setIndexStatus("indexing");
      setIndexProgress(0);

      try {
        const response = await fetch("/api/index", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner: repoData.metadata.owner,
            repo: repoData.metadata.name,
            repoFullName:
              repoData.repoContext?.meta.fullName ??
              `${repoData.metadata.owner}/${repoData.metadata.name}`,
            tree: repoData.tree,
            pushedAt: repoData.repoContext?.meta.pushedAt ?? "",
            defaultBranch: repoData.metadata.defaultBranch,
          }),
        });

        if (!response.ok) throw new Error("Connection failed");

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        if (!reader) return;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            const data = JSON.parse(line);

            if (data.type === "file_data") {
              addFileMetadata(data.file);
            }

            if (data.type === "progress") {
              setIndexProgress(data.percentage);
            }

            if (data.type === "embedding_start") {
              setIndexStatus("embedding");
              setEmbeddingTotal(data.total);
              setEmbeddingProgress(0);
            }

            if (data.type === "embedding_progress") {
              setEmbeddingProgress(data.percentage ?? 0);
            }

            if (data.type === "done") {
              setIndexStatus("ready");
              setIndexProgress(100);
              setEmbeddingProgress(100);
            }

            if (data.type === "error") {
              throw new Error(data.message);
            }
          }
        }
      } catch (error) {
        console.error("Streaming error:", error);
        setIndexStatus("failed");
      }
    };

    startIndexing();
  }, [repoData.tree, repoData.metadata, repoData.repoContext]);

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

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: userMessage,
            repoContext: repoCtx ?? repoData.repoContext,
          }),
          signal: controller.signal,
        });

        if (!response.ok) throw new Error("API error");

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let buffer = "";

        while (true) {
          const { value, done } = await reader!.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              const text: string = parsed.response ?? "";
              if (text) {
                accumulated += text;
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    ...updated[updated.length - 1],
                    content: accumulated,
                  };
                  return updated;
                });
              }
            } catch {}
          }
        }
      } catch (err: any) {
        if (err?.name !== "AbortError") {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: "⚠️ Connection error. Is Ollama running?",
            },
          ]);
        }
      } finally {
        abortControllerRef.current = null;
        setIsLoading(false);
      }
    },
    [input, isLoading, repoCtx, repoData.repoContext],
  );

  const handleStop = () => {
    abortControllerRef.current?.abort();
    setIsLoading(false);
  };

  const handleClear = () => {
    if (isLoading) handleStop();
    setMessages([]);
  };

  const repoName = repoCtx?.meta.name ?? repoData.metadata.name;

  const emptyStateText =
    indexStatus === "indexing"
      ? "Indexing files…"
      : indexStatus === "embedding"
        ? "Building embeddings… you can ask questions now."
        : indexStatus === "ready"
          ? `${filesMetadata.length} files indexed — ask anything.`
          : indexStatus === "failed"
            ? "Indexing failed. Try reloading."
            : "Ask anything about the repo.";

  const isProcessing =
    indexStatus === "indexing" || indexStatus === "embedding";

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

      {isProcessing && (
        <div className="px-3 py-1.5 border-b border-gray-800 bg-gray-950/30 space-y-1.5">
          {/* Indexing bar */}
          <div>
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-[9px] font-mono text-slate-500">
                {indexStatus === "indexing" ? "Indexing files" : "Indexing"}
              </span>
              <span className="text-[9px] font-mono text-slate-500">
                {indexProgress}%
              </span>
            </div>
            <div className="h-0.5 w-full bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${indexProgress}%` }}
              />
            </div>
          </div>

          {/* Embedding bar — shows once embedding starts */}
          {indexStatus === "embedding" && (
            <div>
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[9px] font-mono text-slate-500">
                  Building embeddings
                </span>
                <span className="text-[9px] font-mono text-purple-400">
                  {embeddingProgress}%
                  {embeddingTotal > 0 ? ` of ${embeddingTotal}` : ""}
                </span>
              </div>
              <div className="h-0.5 w-full bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-purple-500 transition-all duration-500"
                  style={{ width: `${embeddingProgress}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-[10px] font-mono text-slate-600 text-center mt-6 leading-relaxed">
            {emptyStateText}
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
          >
            <div
              className={`max-w-[92%] p-2.5 rounded-lg text-[10px] font-mono leading-normal overflow-auto whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-blue-600/10 border border-blue-500/20 text-blue-100"
                  : "bg-slate-900/50 border border-slate-800 text-slate-300"
              }`}
            >
              {msg.content === "" && isLoading ? (
                <Loader2 size={11} className="animate-spin" />
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
            placeholder={
              indexStatus === "indexing"
                ? `Indexing… (${indexProgress}%)`
                : indexStatus === "embedding"
                  ? "Embedding in background…"
                  : `Ask about ${repoName}`
            }
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
