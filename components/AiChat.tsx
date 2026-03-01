// pretty much ai generated but took a while to fix
// claude works like a charm tho

"use client";

import { useState, useRef, useEffect, ReactNode } from "react";
import {
  Cpu,
  Send,
  Loader2,
  FileCode,
  Folder,
  Github,
  Square,
  Trash2,
} from "lucide-react";
import { useSelectionStore } from "@/lib/store";
import { FullRepoData } from "@/app/workspace/page";
import { FileContext, FolderContext, RepoContext } from "@/lib/types";

interface AiChatProps {
  repoData: FullRepoData;
}

function buildRepoContext(ctx: RepoContext): string {
  const {
    meta,
    github,
    latestCommit,
    contributors,
    languages,
    latestRelease,
    branches,
    tree,
    stats,
    stack,
  } = ctx;

  const topLangs = languages
    .slice(0, 5)
    .map((l) => `${l.lang} (${l.pct}%)`)
    .join(", ");
  const topContribs = contributors
    .slice(0, 5)
    .map((c) => `${c.login} (${c.contributions} commits)`)
    .join(", ");
  const topExts = Object.entries(stats.extFrequency)
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .slice(0, 8)
    .map(([ext, count]) => `.${ext}×${count}`)
    .join("  ");

  const rootItems = tree.filter((e) => e.depth === 1);
  const rootFolders = rootItems.filter((e) => e.type === "folder");
  const rootFiles = rootItems.filter((e) => e.type === "file");
  const totleFolders = tree.filter((e) => e.type === "folder");
  const totleFiles = tree.filter((e) => e.type === "file");

  return `
    # REPOSITORY: ${meta.fullName}
    ${github?.description ? `> ${github.description}` : ""}

    ## Metadata
    - Stars: ${meta.stars.toLocaleString()} | Forks: ${meta.forks.toLocaleString()} | Open issues: ${meta.openIssues}
    - Visibility: ${meta.visibility} | License: ${meta.license || "none"}
    - Default branch: ${meta.defaultBranch} | Last pushed: ${meta.pushedAt}
    - Homepage: ${github?.homepage || "—"}
    - Topics: ${github?.topics?.join(", ") || "none"}
    - Owner type: ${github?.ownerType ?? "—"} | Profile: ${github?.ownerProfileUrl ?? "—"}
    - Archived: ${github?.archived} | Fork: ${github?.fork} | Has wiki: ${github?.hasWiki}
    - Clone URL: ${github?.cloneUrl} | SSH: ${github?.sshUrl}

    ## Tech Stack (${stack.architecture})
    - Node/lockfile: ${stack.hasLockfile} | Docker: ${stack.hasDocker} | Tailwind: ${stack.hasTailwind}
    - Next.js: ${stack.hasNextjs} | Vite: ${stack.hasVite} | Webpack: ${stack.hasWebpack}
    - Prisma: ${stack.hasPrisma} | Env file: ${stack.hasEnvFile} | CI/GitHub Actions: ${stack.hasGitActions}
    - Tests: ${stack.hasTests} | README: ${stack.hasReadme}
    - Entry points: ${stack.entryPoints.join(", ") || "none detected"}

    ## Languages
    ${topLangs || "unknown"}

    ## Tree Stats
    - Files: ${stats.totalFiles} | Folders: ${stats.totalFolders} | Max depth: ${stats.maxDepth}
    - Total size: ${(stats.totalSize / 1024).toFixed(1)} KB
    - Dominant extension: .${stats.dominantExt ?? "?"}
    - Extension breakdown: ${topExts}

    ## Root Directory (${rootItems.length} items — ${rootFolders.length} folders, ${rootFiles.length} files)
    ${rootItems.map((e) => `${e.type === "folder" ? "📁" : "📄"} ${e.name}`).join(" · ")}

    ## Latest Commit
    ${latestCommit ? `- ${latestCommit.shortSha} — "${latestCommit.message.split("\n")[0]}" by ${latestCommit.author} on ${latestCommit.date}` : "unknown"}

    ## Top Contributors
    ${topContribs || "unknown"}

    ## Branches (${branches.length})
    ${branches.map((b) => `- ${b.name}${b.protected ? " 🔒" : ""}`).join("\n") || "unknown"}

    ${latestRelease ? `## Latest Release\n- ${latestRelease.tagName}: "${latestRelease.name}" (${latestRelease.publishedAt})${latestRelease.prerelease ? " [pre-release]" : ""}` : ""}

    ## Full File Tree (first 120 entries)
    \`\`\`
    ${tree
      .slice(0, 120)
      .map(
        (e) =>
          `${"  ".repeat(e.depth - 1)}${e.type === "folder" ? "📁" : "📄"} ${e.name}`,
      )
      .join("\n")}
    ${tree.length > 120 ? `... and ${tree.length - 120} more` : ""}
    \`\`\`
  `.trim();
}

function buildFolderContext(ctx: FolderContext): string {
  const {
    name,
    path,
    depth,
    size,
    stats,
    flags,
    children,
    lastCommit,
    subtree,
  } = ctx;
  const topExts = Object.entries(stats.extFrequency)
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .slice(0, 6)
    .map(([ext, count]) => `.${ext}×${count}`)
    .join("  ");

  return `
    # FOLDER: ${path}
    - Name: ${name} | Depth: level ${depth} | Size: ${(size / 1024).toFixed(1)} KB

    ## Contents (${children.length} immediate children)
    ${children.map((c) => `- [${c.type}] ${c.name}${c.size ? `  (${(c.size / 1024).toFixed(1)} KB)` : ""}  sha:${c.sha.slice(0, 8)}`).join("\n")}

    ## Subtree Stats
    - Files: ${stats.totalFiles} | Folders: ${stats.totalFolders} | Max depth: ${stats.maxDepth}
    - Total size: ${(stats.totalSize / 1024).toFixed(1)} KB | Dominant ext: .${stats.dominantExt ?? "?"}
    - Extension breakdown: ${topExts}

    ## Flags
    - Entry point: ${flags.isEntryPoint} | Config folder: ${flags.isConfigFolder} | Test folder: ${flags.isTestFolder}
    - Has README: ${flags.hasReadme} | Has index/main: ${flags.hasIndex} | Has tests: ${flags.hasTests}
    - Has styles: ${flags.hasStyles} | Has dotfiles: ${flags.hasDotfiles}

    ## Last Commit
    ${lastCommit ? `- ${lastCommit.shortSha} — "${lastCommit.message.split("\n")[0]}" by ${lastCommit.author} (${lastCommit.authorEmail}) on ${lastCommit.date}` : "unknown"}

    ## Full Subtree (first 80 entries)
    \`\`\`
    ${subtree
      .slice(0, 80)
      .map(
        (e) =>
          `${"  ".repeat(e.depth - depth)}${e.type === "folder" ? "📁" : "📄"} ${e.name}`,
      )
      .join("\n")}
    ${subtree.length > 80 ? `... and ${subtree.length - 80} more` : ""}
    \`\`\`
  `.trim();
}

function buildFileContext(ctx: FileContext): string {
  const {
    name,
    path,
    ext,
    depth,
    metrics,
    analysis,
    commits,
    contributors,
    topContributor,
    latestCommit,
    firstCommit,
    github,
  } = ctx;
  const preview =
    ctx.content.length > 6000
      ? ctx.content.slice(0, 6000) +
        `\n\n... (truncated, ${ctx.content.length} total chars)`
      : ctx.content;

  return `
    # FILE: ${path}
    - Name: ${name} | Extension: .${ext} | Depth: level ${depth}
    - Size: ${(github.size / 1024).toFixed(2)} KB | SHA: ${github.sha.slice(0, 8)}
    - GitHub URL: ${github.htmlUrl}

    ## Metrics
    - Lines: ${metrics.lineCount} (code: ${metrics.codeLines}, comments: ${metrics.commentLines}, blank: ${metrics.emptyLines})
    - Characters: ${metrics.charCount.toLocaleString()}

    ## Code Analysis
    - Logic type: ${analysis.logicType}
    - React: ${analysis.isReact} | TypeScript: ${analysis.isTypeScript} | JSX: ${analysis.hasJsx}
    - Is test file: ${analysis.isTest} | Is config: ${analysis.isConfig}
    - Functions: ${analysis.functionCount} | Classes: ${analysis.classCount}
    - Complexity score: ${analysis.complexity.score} (branches: ${analysis.complexity.branches}, loops: ${analysis.complexity.loops}, async ops: ${analysis.complexity.asyncOps})
    - Console.log calls: ${analysis.consoleLogs}
    ${analysis.todoComments.length > 0 ? `- TODOs/FIXMEs:\n${analysis.todoComments.map((t) => `  - ${t.trim()}`).join("\n")}` : ""}

    ## Imports (${analysis.imports.length})
    ${
      analysis.imports
        .slice(0, 20)
        .map((i) => `- ${i}`)
        .join("\n") || "none"
    }

    ## Exports (${analysis.exports.length})
    ${analysis.exports.map((e) => `- ${e}`).join("\n") || "none"}

    ## Commit History (${commits.length} commits)
    ${commits
      .slice(0, 10)
      .map(
        (c) =>
          `- ${c.shortSha} "${c.message.split("\n")[0]}" — ${c.author} on ${c.date}${c.verified ? " ✓" : ""}`,
      )
      .join("\n")}
    ${commits.length > 10 ? `... and ${commits.length - 10} more` : ""}

    ## Contributors (${contributors.length})
    ${contributors.map((c) => `- ${c.name} <${c.email}>: ${c.commits} commits (${c.firstCommit.slice(0, 10)} → ${c.lastCommit.slice(0, 10)})`).join("\n") || "unknown"}
    ${topContributor ? `- Top contributor: ${topContributor.name} with ${topContributor.commits} commits` : ""}

    ## First / Latest Commit
    - First:  ${firstCommit ? `${firstCommit.shortSha} "${firstCommit.message.split("\n")[0]}" by ${firstCommit.author} on ${firstCommit.date}` : "unknown"}
    - Latest: ${latestCommit ? `${latestCommit.shortSha} "${latestCommit.message.split("\n")[0]}" by ${latestCommit.author} on ${latestCommit.date}` : "unknown"}

    ## Source
    \`\`\`${ext}
    ${preview}
    \`\`\`
  `.trim();
}

const STRIP_PATTERNS = [
  /\[BEGIN_OF_EXPLANATION\]/g,
  /\[END_OF_EXPLANATION\]/g,
  /\[EXPLANATION\]/g,
  /^(TOOL CALL:|ANSWER:|RESPONSE:)\s*/gm,
];

function extractTextFromChunk(line: string): string {
  if (!line.trim()) return "";
  try {
    const parsed = JSON.parse(line);
    let text: string = parsed.response ?? "";
    for (const pattern of STRIP_PATTERNS) text = text.replace(pattern, "");
    return text;
  } catch {
    return "";
  }
}

const AiChat = ({ repoData }: AiChatProps) => {
  const [messages, setMessages] = useState<
    { role: string; content: ReactNode }[]
  >([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const {
    type: selectionType,
    name: selectionName,
    path: selectionPath,
    repoContext: repoCtx,
    folderContext: folderCtx,
    fileContext: fileCtx,
  } = useSelectionStore((s) => s.selection);

  const setRepoContext = useSelectionStore((s) => s.setRepoContext);

  useEffect(() => {
    if (repoData.repoContext) {
      setRepoContext(repoData.repoContext);
    }
  }, [repoData.repoContext, setRepoContext]);

  function buildContextBlock(): string {
    if (selectionType === "file" && fileCtx) return buildFileContext(fileCtx);
    if (selectionType === "folder" && folderCtx)
      return buildFolderContext(folderCtx);
    if (selectionType === "repo") {
      if (!repoCtx) return "No repo context available.";
      return buildRepoContext(repoCtx);
    }
    return "No context selected. The user has not clicked a file, folder, or repo node yet.";
  }

  const handleStop = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsLoading(false);
  };

  const handleClear = () => {
    if (isLoading) handleStop();
    setMessages([]);
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const userMessage = input.trim();
    if (!userMessage || isLoading) return;

    const contextBlock = buildContextBlock();

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
      const prompt = `
        You are RepoOrbit, an AI assistant analysing the GitHub repository "${repoData.metadata.fullName}".
        ---
        ${contextBlock}
        ---
        Answer the user's question using only the context above. Be concise and direct.
        Provide the raw answer immediately without any introductory filler or meta-commentary.
        If the answer is not in the context, say so clearly.
        If it's a greeting or off-topic question, respond with a friendly tone.
        ---
        USER: ${userMessage}
      `.trim();

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error("API error");

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { value, done } = await reader!.read();
        if (done) break;
        const text = extractTextFromChunk(decoder.decode(value));
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
  };

  const ContextBadge = () => {
    if (selectionType === "file" && fileCtx) {
      return (
        <span
          className="flex items-center gap-1 text-[11px] font-mono text-slate-400 truncate max-w-[140px] border-2 border-gray-600 py-1 px-2 rounded-2xl"
          title={selectionPath}
        >
          <FileCode size={13} className="shrink-0 text-blue-400" />
          {selectionName}
        </span>
      );
    }
    if (selectionType === "folder" && folderCtx) {
      return (
        <span
          className="flex items-center gap-1 text-[11px] font-mono text-slate-400 truncate max-w-[140px] border-2 border-gray-600 py-1 px-2 rounded-2xl"
          title={selectionPath}
        >
          <Folder size={13} className="shrink-0 text-yellow-400" />
          {selectionName}
        </span>
      );
    }
    if (selectionType === "repo" || selectionType === "root") {
      const name = repoCtx?.meta.name ?? repoData.metadata.name;
      const full = repoCtx?.meta.fullName ?? repoData.metadata.fullName;
      return (
        <span
          className="flex items-center gap-1 text-[11px] font-mono text-slate-400 truncate max-w-[140px] border-2 border-gray-600 py-1 px-2 rounded-2xl"
          title={full}
        >
          <Github size={13} className="shrink-0 text-purple-400" />
          {name}
        </span>
      );
    }
    return (
      <span className="text-[11px] font-mono text-slate-600">no context</span>
    );
  };

  return (
    <div className="w-80 shrink-0 flex flex-col bg-gray-900 border-2 border-gray-600 rounded-2xl overflow-hidden h-full shadow-2xl">
      {/* header */}
      <div className="px-4 py-3 border-b-2 border-gray-600 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu size={14} className="text-blue-500" />
          <span className="text-[10px] font-mono font-bold text-gray-300 uppercase tracking-wider pt-1">
            AI Agent
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ContextBadge />
          {messages.length > 0 && !isLoading && (
            <button
              onClick={handleClear}
              title="Clear chat"
              className="text-gray-600 hover:text-red-400 transition-colors"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      {/* messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <p className="text-[11px] font-mono text-slate-600 text-center mt-8">
            Click a file, folder, or repo node,
            <br />
            then ask anything about it.
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
          >
            <div
              className={`max-w-[95%] p-3 rounded-xl text-[11px] font-mono leading-relaxed overflow-auto ${
                msg.role === "user"
                  ? "bg-blue-600/20 border border-blue-500/30 text-blue-50"
                  : "bg-slate-900 border border-slate-800 text-slate-300"
              }`}
            >
              {msg.content === "" && isLoading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                msg.content
              )}
            </div>
          </div>
        ))}
      </div>

      <form
        onSubmit={handleSend}
        className="p-3 bg-gray-900 border-t-2 border-gray-600"
      >
        <div className="relative">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isLoading}
            placeholder={
              selectionType === "file"
                ? `Ask about ${selectionName}`
                : selectionType === "folder"
                  ? `Ask about /${selectionName}`
                  : `Ask about ${repoCtx?.meta.name ?? repoData.metadata.name}`
            }
            className="w-full bg-gray-900 border-2 border-gray-600 text-[11px] font-mono text-slate-300 px-4 py-2 rounded-xl outline-none focus:border-blue-500/50 disabled:opacity-50"
          />
          {isLoading ? (
            <button
              type="button"
              onClick={handleStop}
              title="Stop generation"
              className="absolute right-3 top-[11px] text-red-400 hover:text-red-300 transition-colors"
            >
              <Square size={14} className="fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="absolute right-3 top-[11px] text-gray-200 hover:text-blue-400 disabled:opacity-30 transition-colors"
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

export default AiChat;
