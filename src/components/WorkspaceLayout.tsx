import { useState, useRef, useEffect } from "react";

const vscode = (window as any).acquireVsCodeApi?.();
if (vscode) {
  (window as any).vscode = vscode;
}
import {
  Bot,
  RefreshCw,
  ChevronDown,
  Play,
  Pause,
  FileText,
  Trash2,
  Terminal,
  Globe,
  Cpu,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  steps?: any[];
}

export interface WorkspaceLayoutProps {
  repoUrl?: string;
  error?: string | null;
}

function parseAndExpandQueries(queries: string[]): string[] {
  const expanded: string[] = [];
  for (const query of queries) {
    const trimmed = query.trim();
    const workflowMatch = trimmed.match(/^workflow:\s*\[(.*?)\](?:\s+(.*))?$/i);
    if (workflowMatch) {
      const question = workflowMatch[2]?.trim() || "";
      if (question) {
        expanded.push(question);
      }
    } else {
      expanded.push(query);
    }
  }
  return expanded;
}

// Icons
const ClaudeIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 100 100"
    className={className}
    fill="hsl(14.8, 63.1%, 59.6%)"
  >
    <path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z" />
  </svg>
);

const OpenAIIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" role="img" className={className} fill="currentColor">
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
);

const GeminiIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 65 65" className={className} fill="none">
    <mask
      id="maskme"
      style={{ maskType: "alpha" }}
      maskUnits="userSpaceOnUse"
      x="0"
      y="0"
      width="65"
      height="65"
    >
      <path
        d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.904 38.904 0 001.999 5.905c2.152 5 5.105 9.376 8.854 13.125 3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 005.906 1.999c.66.166 1.124.758 1.124 1.438 0 .68-.464 1.273-1.125 1.439a38.902 38.902 0 00-5.905 1.999c-5 2.152-9.375 5.105-13.125 8.854-3.749 3.751-6.702 8.126-8.854 13.125a38.973 38.973 0 00-2 5.906 1.485 1.485 0 01-1.438 1.124c-.68 0-1.272-.464-1.438-1.125a38.913 38.913 0 00-2-5.905c-2.151-5-5.103-9.375-8.854-13.125-3.75-3.749-8.125-6.702-13.125-8.854a38.973 38.973 0 00-5.905-2A1.485 1.485 0 010 32.448c0-.68.465-1.272 1.125-1.438a38.903 38.903 0 005.905-2c5-2.151 9.376-5.104 13.125-8.854 3.75-3.749 6.703-8.125 8.855-13.125a38.972 38.972 0 001.999-5.905A1.485 1.485 0 0132.447 0z"
        fill="#000"
      />
      <path
        d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.904 38.904 0 001.999 5.905c2.152 5 5.105 9.376 8.854 13.125 3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 005.906 1.999c.66.166 1.124.758 1.124 1.438 0 .68-.464 1.273-1.125 1.439a38.902 38.902 0 00-5.905 1.999c-5 2.152-9.375 5.105-13.125 8.854-3.749 3.751-6.702 8.126-8.854 13.125a38.973 38.973 0 00-2 5.906 1.485 1.485 0 01-1.438 1.124c-.68 0-1.272-.464-1.438-1.125a38.913 38.913 0 00-2-5.905c-2.151-5-5.103-9.375-8.854-13.125-3.75-3.749-8.125-6.702-13.125-8.854a38.973 38.973 0 00-5.905-2A1.485 1.485 0 010 32.448c0-.68.465-1.272 1.125-1.438a38.903 38.903 0 005.905-2c5-2.151 9.376-5.104 13.125-8.854 3.75-3.749 6.703-8.125 8.855-13.125a38.972 38.972 0 001.999-5.905A1.485 1.485 0 0132.447 0z"
        fill="url(#prefix__paint0_linear_2001_67)"
      />
    </mask>
    <g mask="url(#maskme)">
      <g filter="url(#prefix__filter0_f_2001_67)">
        <path
          d="M-5.859 50.734c7.498 2.663 16.116-2.33 19.249-11.152 3.133-8.821-.406-18.131-7.904-20.794-7.498-2.663-16.116 2.33-19.25 11.151-3.132 8.822.407 18.132 7.905 20.795z"
          fill="#FFE432"
        />
      </g>
      <g filter="url(#prefix__filter1_f_2001_67)">
        <path
          d="M27.433 21.649c10.3 0 18.651-8.535 18.651-19.062 0-10.528-8.35-19.062-18.651-19.062S8.78-7.94 8.78 2.587c0 10.527 8.35 19.062 18.652 19.062z"
          fill="#FC413D"
        />
      </g>
      <g filter="url(#prefix__filter2_f_2001_67)">
        <path
          d="M20.184 82.608c10.753-.525 18.918-12.244 18.237-26.174-.68-13.93-9.95-24.797-20.703-24.271C6.965 32.689-1.2 44.407-.519 58.337c.681 13.93 9.95 24.797 20.703 24.271z"
          fill="#00B95C"
        />
      </g>
      <g filter="url(#prefix__filter3_f_2001_67)">
        <path
          d="M20.184 82.608c10.753-.525 18.918-12.244 18.237-26.174-.68-13.93-9.95-24.797-20.703-24.271C6.965 32.689-1.2 44.407-.519 58.337c.681 13.93 9.95 24.797 20.703 24.271z"
          fill="#00B95C"
        />
      </g>
      <g filter="url(#prefix__filter4_f_2001_67)">
        <path
          d="M30.954 74.181c9.014-5.485 11.427-17.976 5.389-27.9-6.038-9.925-18.241-13.524-27.256-8.04-9.015 5.486-11.428 17.977-5.39 27.902 6.04 9.924 18.242 13.523 27.257 8.038z"
          fill="#00B95C"
        />
      </g>
      <g filter="url(#prefix__filter5_f_2001_67)">
        <path
          d="M67.391 42.993c10.132 0 18.346-7.91 18.346-17.666 0-9.757-8.214-17.667-18.346-17.667s-18.346 7.91-18.346 17.667c0 9.757 8.214 17.666 18.346 17.666z"
          fill="#3186FF"
        />
      </g>
      <g filter="url(#prefix__filter6_f_2001_67)">
        <path
          d="M-13.065 40.944c9.33 7.094 22.959 4.869 30.442-4.972 7.483-9.84 5.987-23.569-3.343-30.663C4.704-1.786-8.924.439-16.408 10.28c-7.483 9.84-5.986 23.57 3.343 30.664z"
          fill="#FBBC04"
        />
      </g>
      <g filter="url(#prefix__filter7_f_2001_67)">
        <path
          d="M34.74 51.43c11.135 7.656 25.896 5.524 32.968-4.764 7.073-10.287 3.779-24.832-7.357-32.488C49.215 6.52 34.455 8.654 27.382 18.94c-7.072 10.288-3.779 24.833 7.357 32.49z"
          fill="#3186FF"
        />
      </g>
      <g filter="url(#prefix__filter8_f_2001_67)">
        <path
          d="M54.984-2.336c2.833 3.852-.808 11.34-8.131 16.727-7.324 5.387-15.557 6.631-18.39 2.78-2.833-3.853.807-11.342 8.13-16.728 7.324-5.387 15.558-6.631 18.39-2.78z"
          fill="#749BFF"
        />
      </g>
      <g filter="url(#prefix__filter9_f_2001_67)">
        <path
          d="M31.727 16.104C43.053 5.598 46.94-8.626 40.41-15.666c-6.53-7.04-21.006-4.232-32.332 6.274s-15.214 24.73-8.683 31.77c6.53 7.04 21.006 4.232 32.332-6.274z"
          fill="#FC413D"
        />
      </g>
      <g filter="url(#prefix__filter10_f_2001_67)">
        <path
          d="M8.51 53.838c6.732 4.818 14.46 5.55 17.262 1.636 2.802-3.915-.384-10.994-7.116-15.812-6.731-4.818-14.46-5.55-17.261-1.636-2.802 3.915.383 10.994 7.115 15.812"
          fill="#FFEE48"
        />
      </g>
    </g>
    <defs>
      <filter
        id="prefix__filter0_f_2001_67"
        x="-19.824"
        y="13.152"
        width="39.274"
        height="43.217"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur
          stdDeviation="2.46"
          result="effect1_foregroundBlur_2001_67"
        />
      </filter>
      <filter
        id="prefix__filter1_f_2001_67"
        x="-15.001"
        y="-40.257"
        width="84.868"
        height="85.688"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur
          stdDeviation="11.891"
          result="effect1_foregroundBlur_2001_67"
        />
      </filter>
      <filter
        id="prefix__filter2_f_2001_67"
        x="-20.776"
        y="11.927"
        width="79.454"
        height="90.916"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur
          stdDeviation="10.109"
          result="effect1_foregroundBlur_2001_67"
        />
      </filter>
      <filter
        id="prefix__filter3_f_2001_67"
        x="-20.776"
        y="11.927"
        width="79.454"
        height="90.916"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur
          stdDeviation="10.109"
          result="effect1_foregroundBlur_2001_67"
        />
      </filter>
      <filter
        id="prefix__filter4_f_2001_67"
        x="-19.845"
        y="15.459"
        width="79.731"
        height="81.505"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur
          stdDeviation="10.109"
          result="effect1_foregroundBlur_2001_67"
        />
      </filter>
      <filter
        id="prefix__filter5_f_2001_67"
        x="29.832"
        y="-11.552"
        width="75.117"
        height="73.758"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur
          stdDeviation="9.606"
          result="effect1_foregroundBlur_2001_67"
        />
      </filter>
      <filter
        id="prefix__filter6_f_2001_67"
        x="-38.583"
        y="-16.253"
        width="78.135"
        height="78.758"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur
          stdDeviation="8.706"
          result="effect1_foregroundBlur_2001_67"
        />
      </filter>
      <filter
        id="prefix__filter7_f_2001_67"
        x="8.107"
        y="-5.966"
        width="78.877"
        height="77.539"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur
          stdDeviation="7.775"
          result="effect1_foregroundBlur_2001_67"
        />
      </filter>
      <filter
        id="prefix__filter8_f_2001_67"
        x="13.587"
        y="-18.488"
        width="56.272"
        height="51.81"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur
          stdDeviation="6.957"
          result="effect1_foregroundBlur_2001_67"
        />
      </filter>
      <filter
        id="prefix__filter9_f_2001_67"
        x="-15.526"
        y="-31.297"
        width="70.856"
        height="69.306"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur
          stdDeviation="5.876"
          result="effect1_foregroundBlur_2001_67"
        />
      </filter>
      <filter
        id="prefix__filter10_f_2001_67"
        x="-14.168"
        y="20.964"
        width="55.501"
        height="51.571"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur
          stdDeviation="7.273"
          result="effect1_foregroundBlur_2001_67"
        />
      </filter>
      <linearGradient
        id="prefix__paint0_linear_2001_67"
        x1="18.447"
        y1="43.42"
        x2="52.153"
        y2="15.004"
        gradientUnits="userSpaceOnUse"
      >
        <stop stopColor="#4893FC" />
        <stop offset=".27" stopColor="#4893FC" />
        <stop offset=".777" stopColor="#969DFF" />
        <stop offset="1" stopColor="#BD99FE" />
      </linearGradient>
    </defs>
  </svg>
);

const VendorIcon = ({
  vendor,
  className = "w-3 h-3",
}: {
  vendor: string;
  className?: string;
}) => {
  const v = vendor?.toLowerCase();
  if (v === "google" || v === "gemini") {
    return <GeminiIcon className={className} />;
  }
  if (v === "anthropic" || v === "claude") {
    return <ClaudeIcon className={className} />;
  }
  if (v === "openai" || v === "gpt") {
    return <OpenAIIcon className={className} />;
  }
  return <Bot className={className} />;
};

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

export default function WorkspaceLayout({
  repoUrl: initialRepoUrl = "",
  error: initialError = null,
}: WorkspaceLayoutProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRestored, setIsRestored] = useState(false);
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
  const [retryCount, setRetryCount] = useState<number>(0);
  const [queriesFileExists, setQueriesFileExists] = useState<boolean>(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [repoUrl, setRepoUrl] = useState(initialRepoUrl);
  const [showCloneModal, setShowCloneModal] = useState(false);
  const [clonePath, setClonePath] = useState("./");
  const [isCloning, setIsCloning] = useState(false);
  const [isWorkspaceEmpty, setIsWorkspaceEmpty] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const [forkOwner, setForkOwner] = useState<string>("");
  const [upstreamOwner, setUpstreamOwner] = useState<string>("");
  const [upstreamRepo, setUpstreamRepo] = useState<string>("");
  const [branchName, setBranchName] = useState<string>("");
  const [defaultBranch, setDefaultBranch] = useState<string>("");

  const latestData = useRef({
    loadedQueries,
    config,
    isPlaying,
    currentQueryIndex,
    retryCount,
    forkOwner,
    upstreamOwner,
    upstreamRepo,
    branchName,
    defaultBranch,
  });
  useEffect(() => {
    latestData.current = {
      loadedQueries,
      config,
      isPlaying,
      currentQueryIndex,
      retryCount,
      forkOwner,
      upstreamOwner,
      upstreamRepo,
      branchName,
      defaultBranch,
    };
  }, [
    loadedQueries,
    config,
    isPlaying,
    currentQueryIndex,
    retryCount,
    forkOwner,
    upstreamOwner,
    upstreamRepo,
    branchName,
    defaultBranch,
  ]);

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // vscode is acquired at module scope above

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const activeModel = availableModels.find((m) => m.id === config.model);
  const activeVendor =
    activeModel?.vendor?.toLowerCase() ||
    (config.model.toLowerCase().includes("gemini")
      ? "google"
      : config.model.toLowerCase().includes("claude")
        ? "anthropic"
        : config.model.toLowerCase().includes("gpt")
          ? "openai"
          : "unknown");

  // Initial check and queries subscription
  useEffect(() => {
    if (vscode) {
      vscode.postMessage({ command: "checkWorkspaceStatus" });
      vscode.postMessage({ command: "readQueriesFile" });
      vscode.postMessage({ command: "getStoredState" });
      const timer = setInterval(() => {
        vscode.postMessage({ command: "readQueriesFile" });
      }, 3000);
      return () => clearInterval(timer);
    }
  }, []);

  // Sync state to extension host
  useEffect(() => {
    if (!isRestored) return;
    if (vscode) {
      vscode.postMessage({
        command: "syncState",
        state: {
          messages,
          isPlaying,
          currentQueryIndex,
          retryCount,
          isLoading,
          repoUrl,
          forkOwner,
          upstreamOwner,
          upstreamRepo,
          branchName,
          defaultBranch,
          config,
        },
      });
    }
  }, [
    isRestored,
    messages,
    isPlaying,
    currentQueryIndex,
    retryCount,
    isLoading,
    repoUrl,
    forkOwner,
    upstreamOwner,
    upstreamRepo,
    branchName,
    defaultBranch,
    config,
  ]);

  // Trigger query execution when currentQueryIndex changes or autoplay starts
  useEffect(() => {
    if (!isPlaying || currentQueryIndex === -1 || isLoading) return;

    const { loadedQueries: queries, config: cfg } = latestData.current;
    if (currentQueryIndex < queries.length) {
      const timer = setTimeout(() => {
        const query = queries[currentQueryIndex];
        const combinedQuery = `System prompt: You are Antigravity, a coding assistant. Optimize and resolve the user request.\n\n${query}`;

        setMessages((prev) => [
          ...prev,
          { role: "user", content: query },
          { role: "assistant", content: "" },
        ]);
        setIsLoading(true);

        if (vscode) {
          vscode.postMessage({
            command: "chat",
            query: combinedQuery,
            config: cfg,
          });
        }
      }, 800); // 800ms delay between queries for visual flow

      return () => clearTimeout(timer);
    }
  }, [isPlaying, currentQueryIndex]);

  const handleCreateQueriesFile = () => {
    if (vscode) {
      vscode.postMessage({ command: "createQueriesFile" });
    }
  };

  const handlePlayPause = () => {
    if (loadedQueries.length === 0) return;

    if (isPlaying) {
      setIsPlaying(false);
    } else {
      let startIndex = currentQueryIndex;
      if (startIndex >= loadedQueries.length || startIndex < 0) {
        startIndex = 0;
      }
      setIsPlaying(true);
      setRetryCount(0);
      setCurrentQueryIndex(startIndex);
    }
  };

  const handleClearChat = () => {
    setMessages([]);
    setIsPlaying(false);
    setCurrentQueryIndex(-1);
    setRetryCount(0);
    setIsLoading(false);
    if (vscode) {
      vscode.postMessage({ command: "clearChat" });
    }
  };

  const handleSendManualMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const query = input.trim();
    setInput("");

    // Track as a single-item automated queue run to execute the self-healing and git push pipeline
    setLoadedQueries([query]);
    setCurrentQueryIndex(0);
    setIsPlaying(true);
    setRetryCount(0);

    setMessages([
      { role: "user", content: query },
      { role: "assistant", content: "" },
    ]);
    setIsLoading(true);

    const combinedQuery = `System prompt: You are Antigravity, a coding assistant. Optimize and resolve the user request.\n\n${query}`;
    if (vscode) {
      vscode.postMessage({
        command: "chat",
        query: combinedQuery,
        config,
      });
    }
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
    if (vscode) {
      setIsRefreshing(true);
      vscode.postMessage({ command: "getModels" });
      setTimeout(() => setIsRefreshing(false), 3000);
    }
  };

  // Main listener for messages from extension host
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      switch (message.command) {
        case "cloneSuccess":
          setIsCloning(false);
          setShowCloneModal(false);
          setForkOwner(message.forkOwner || "");
          setUpstreamOwner(message.upstreamOwner || "");
          setUpstreamRepo(message.upstreamRepo || "");
          setBranchName(message.branchName || "");
          setDefaultBranch(message.defaultBranch || "");
          if (vscode) {
            vscode.postMessage({ command: "checkWorkspaceStatus" });
            vscode.postMessage({
              command: "alert",
              text: `🚀 Success! Repository cloned & forked to ${message.forkOwner}/${message.upstreamRepo} on branch ${message.branchName}. Antigravity skills and rules have been initialized.`,
            });
          }
          break;
        case "setError":
          setError(message.text);
          setIsCloning(false);
          break;
        case "workspaceStatus":
          setIsWorkspaceEmpty(message.isEmpty);
          break;
        case "chatResponse":
        case "chatStream":
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
              {
                role: "assistant",
                content: message.text,
                steps: message.steps,
              },
            ];
          });
          if (message.command === "chatResponse") {
            setIsLoading(false);
            if (latestData.current.isPlaying) {
              if (vscode) {
                vscode.postMessage({
                  command: "runReview",
                  queryIndex: latestData.current.currentQueryIndex,
                  queryText:
                    latestData.current.loadedQueries[
                      latestData.current.currentQueryIndex
                    ] || "RepoOrbit Auto-Fix",
                  repoUrl: repoUrl,
                  attempts: latestData.current.retryCount + 1,
                  forkOwner: latestData.current.forkOwner,
                  upstreamOwner: latestData.current.upstreamOwner,
                  upstreamRepo: latestData.current.upstreamRepo,
                  branchName: latestData.current.branchName,
                  defaultBranch: latestData.current.defaultBranch,
                });
              }
            }
          }
          break;
        case "reviewResponse":
          const {
            queryIndex,
            rating,
            feedback,
            error: reviewErr,
            attempts,
          } = message;

          if (reviewErr) {
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content: `⚠️ **Code Review Skipped:** ${reviewErr}`,
              },
            ]);
            setRetryCount(0);
            const nextIndex = latestData.current.currentQueryIndex + 1;
            if (nextIndex < latestData.current.loadedQueries.length) {
              setCurrentQueryIndex(nextIndex);
            } else {
              setIsPlaying(false);
            }
            return;
          }

          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: `🔍 **Code Review (Rating: ${rating}/5, Attempt: ${attempts}/3)**\n\n${feedback}`,
            },
          ]);

          if (rating >= 4) {
            setRetryCount(0);
            const nextIndex = latestData.current.currentQueryIndex + 1;
            if (nextIndex < latestData.current.loadedQueries.length) {
              setCurrentQueryIndex(nextIndex);
            } else {
              setIsPlaying(false);
            }
          } else {
            if (attempts < 3) {
              setRetryCount(attempts);
              setIsLoading(true);
              const repairQuery = `Code Review rated the changes as ${rating}/5.\n\nFeedback:\n${feedback}\n\nPlease update the codebase to fix these issues. Ensure all concerns are fully addressed.`;
              const combinedQuery = `System prompt: You are Antigravity, a coding assistant. Optimize and resolve the user request.\n\n${repairQuery}`;

              setMessages((prev) => [
                ...prev,
                { role: "user", content: repairQuery },
                { role: "assistant", content: "" },
              ]);

              if (vscode) {
                vscode.postMessage({
                  command: "chat",
                  query: combinedQuery,
                  config: latestData.current.config,
                });
              }
            } else {
              setMessages((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: `⚠️ **Code Review:** Maximum healing attempts (3) reached. Progressing to the next query.`,
                },
              ]);
              setRetryCount(0);
              const nextIndex = latestData.current.currentQueryIndex + 1;
              if (nextIndex < latestData.current.loadedQueries.length) {
                setCurrentQueryIndex(nextIndex);
              } else {
                setIsPlaying(false);
              }
            }
          }
          break;
        case "chatError":
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
          setIsPlaying(false);
          break;
        case "setModels":
          const models = message.models || [];
          setAvailableModels(models);
          setIsRefreshing(false);
          setIsFallback(!!message.isFallback);

          if (models.length > 0) {
            setConfig((prev) => {
              const currentExists = models.some(
                (m: any) => m.id === prev.model,
              );
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
          break;
        case "queriesFileResponse":
          setQueriesFileExists(message.exists);
          const processed = parseAndExpandQueries(message.queries || []);
          setLoadedQueries((prev) => {
            if (JSON.stringify(prev) === JSON.stringify(processed)) return prev;
            return processed;
          });
          break;
        case "restoreState":
          const restored = message.state;
          if (restored) {
            if (restored.messages) setMessages(restored.messages);
            if (typeof restored.isPlaying === 'boolean') setIsPlaying(restored.isPlaying);
            if (typeof restored.currentQueryIndex === 'number') setCurrentQueryIndex(restored.currentQueryIndex);
            if (typeof restored.retryCount === 'number') setRetryCount(restored.retryCount);
            if (typeof restored.isLoading === 'boolean') setIsLoading(restored.isLoading);
            if (typeof restored.repoUrl === 'string') setRepoUrl(restored.repoUrl);
            if (restored.forkOwner) setForkOwner(restored.forkOwner);
            if (restored.upstreamOwner) setUpstreamOwner(restored.upstreamOwner);
            if (restored.upstreamRepo) setUpstreamRepo(restored.upstreamRepo);
            if (restored.branchName) setBranchName(restored.branchName);
            if (restored.defaultBranch) setDefaultBranch(restored.defaultBranch);
            if (restored.config) setConfig(restored.config);
          }
          setIsRestored(true);
          break;
      }
    };

    window.addEventListener("message", handleMessage);
    refreshModels();
    return () => window.removeEventListener("message", handleMessage);
  }, [config.model, repoUrl]);

  return (
    <div
      id="workspace-viewport"
      className="h-screen w-screen bg-[var(--color-antigravity-bg)] text-[var(--color-antigravity-text-primary)] flex overflow-hidden font-sans pt-1 relative"
    >
      <div
        className="w-full flex flex-col bg-[var(--color-antigravity-bg)] h-full overflow-hidden neural-grid relative vendor-glow"
        data-vendor={activeVendor}
      >
        {/* Top Part: Title, Repository search, and Model Selector */}
        <div className="flex-none bg-[var(--color-antigravity-panel)]/40 border-b border-[var(--color-antigravity-border)] relative z-30">
          <div className="px-3 h-10 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <Terminal
                size={12}
                className="text-[var(--color-antigravity-accent)] shrink-0"
              />

              <div className="flex items-center gap-2 bg-[var(--vscode-input-background,rgba(0,0,0,0.15))] border border-[var(--vscode-input-border,var(--color-antigravity-border))] rounded-md px-2.5 h-6 max-w-[450px] w-full focus-within:border-[var(--color-antigravity-accent)]/45 transition-all">
                <Globe
                  size={11}
                  className="text-[var(--vscode-input-placeholderForeground,var(--color-antigravity-text-secondary))] shrink-0"
                />
                <input
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      const val = repoUrl.trim();
                      if (val) {
                        const parts = val.replace(/\/$/, "").split("/");
                        setShowCloneModal(true);
                      }
                    }
                  }}
                  type="text"
                  placeholder="github.com/owner/repo"
                  className="flex-grow bg-transparent outline-none font-mono text-[10px] text-[var(--vscode-input-foreground,var(--color-antigravity-text-primary))] placeholder:text-[var(--vscode-input-placeholderForeground,var(--color-antigravity-text-secondary))]/60 h-full"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {/* Custom Model Dropdown Selector */}
              <div className="relative" ref={dropdownRef}>
                <button
                  type="button"
                  onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                  disabled={availableModels.length === 0}
                  className="flex items-center gap-2 px-2.5 py-1 bg-white/[0.03] border border-[var(--color-antigravity-border)] rounded-md h-6.5 text-[10px] font-medium tracking-tight text-[var(--color-antigravity-text-secondary)] hover:bg-white/[0.06] hover:text-[var(--color-antigravity-text-primary)] hover:border-[var(--color-antigravity-accent)]/30 active:scale-97 transition-all cursor-pointer select-none disabled:opacity-50"
                >
                  <VendorIcon
                    vendor={activeVendor}
                    className="w-3.5 h-3.5 shrink-0"
                  />
                  <span className="truncate max-w-[100px]">
                    {activeModel ? activeModel.name : "Engines offline..."}
                  </span>
                  <ChevronDown
                    size={10}
                    className={`opacity-60 transition-transform duration-200 ${isDropdownOpen ? "rotate-180" : ""}`}
                  />
                </button>

                {isDropdownOpen && (
                  <div className="absolute right-0 mt-1.5 w-60 rounded-lg glass-dropdown p-1.5 z-50 flex flex-col gap-0.5 border border-white/[0.08]">
                    <div className="px-2.5 py-1 mb-1 border-b border-white/[0.04]">
                      <p className="text-[8px] font-bold text-zinc-500 uppercase tracking-wider">
                        Available Inference Engines
                      </p>
                    </div>
                    <div className="max-h-56 overflow-y-auto custom-scrollbar flex flex-col gap-0.5">
                      {availableModels.map((model) => {
                        const vendor =
                          model.vendor?.toLowerCase() ||
                          (model.id.toLowerCase().includes("gemini")
                            ? "google"
                            : model.id.toLowerCase().includes("claude")
                              ? "anthropic"
                              : model.id.toLowerCase().includes("gpt")
                                ? "openai"
                                : "unknown");
                        const isSelected = model.id === config.model;
                        const quotaNum = Number(model.quota);
                        const showQuota = !isNaN(quotaNum);

                        return (
                          <button
                            key={model.id}
                            type="button"
                            onClick={() => {
                              setConfig({ ...config, model: model.id });
                              setIsDropdownOpen(false);
                            }}
                            className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-[10px] text-left transition-all ${
                              isSelected
                                ? "bg-[var(--color-antigravity-highlight)] text-[var(--color-antigravity-text-primary)] font-medium"
                                : "text-zinc-400 hover:bg-white/[0.04] hover:text-[var(--color-antigravity-text-primary)]"
                            }`}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <VendorIcon
                                vendor={vendor}
                                className="w-3.5 h-3.5 shrink-0"
                              />
                              <span className="truncate">{model.name}</span>
                            </div>
                            {showQuota && (
                              <div className="flex items-center gap-1.5 shrink-0 ml-2">
                                <div className="w-10 h-1 bg-white/5 rounded-full overflow-hidden border border-white/5">
                                  <div
                                    className={`h-full rounded-full ${
                                      quotaNum > 0.5
                                        ? "bg-emerald-500"
                                        : quotaNum > 0.2
                                          ? "bg-amber-500"
                                          : "bg-red-500"
                                    }`}
                                    style={{ width: `${quotaNum * 100}%` }}
                                  />
                                </div>
                                <span className="text-[8px] font-mono opacity-50">
                                  {(quotaNum * 100).toFixed(0)}%
                                </span>
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <button
                onClick={handleClearChat}
                className="p-1 rounded-md text-[var(--color-antigravity-text-secondary)] hover:text-[var(--color-antigravity-text-primary)] hover:bg-white/[0.05] transition-all"
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

          <div className="flex flex-col gap-4 p-4">
            {messages.map((msg, i) => {
              const isUser = msg.role === "user";
              return (
                <div
                  key={i}
                  className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[92%] text-[11px] leading-[1.6] font-normal selection:bg-[var(--color-antigravity-accent)]/20 transition-all ${
                      isUser
                        ? "bg-[var(--color-antigravity-highlight)] border border-[var(--color-antigravity-accent)]/20 px-4 py-3 rounded-2xl rounded-tr-sm text-[var(--color-antigravity-text-primary)] shadow-md shadow-black/10"
                        : "w-full bg-[var(--color-antigravity-panel)]/30 border border-[var(--color-antigravity-border)] px-4 py-4 rounded-2xl rounded-tl-sm text-[var(--color-antigravity-text-primary)] hover:border-white/[0.06] transition-colors"
                    }`}
                  >
                    {!isUser && (
                      <div className="flex items-center gap-1.5 mb-2 pb-1.5 border-b border-white/[0.02]">
                        <VendorIcon
                          vendor={activeVendor}
                          className="w-3 h-3 shrink-0"
                        />
                        <span className="text-[8px] font-mono font-bold uppercase tracking-wider text-zinc-500">
                          {activeModel?.name || "Assistant"}
                        </span>
                      </div>
                    )}

                    {msg.role === "assistant" &&
                    (!msg.content ||
                      (isLoading && i === messages.length - 1)) ? (
                      <div className="py-2.5 px-3 bg-white/[0.02] border border-white/[0.04] rounded-lg relative overflow-hidden group/loading">
                        <div className="flex flex-col gap-1.5 relative z-10">
                          <div className="font-mono text-[9px] text-[var(--color-antigravity-text-secondary)]/70 flex items-center gap-2 overflow-hidden whitespace-nowrap">
                            <span>
                              {msg.steps && msg.steps.length > 0
                                ? msg.steps[msg.steps.length - 1]
                                    ?.plannerResponse?.thinking ||
                                  "Executing logic flow..."
                                : "Thinking..."}
                            </span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <MarkdownRenderer content={msg.content} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div ref={messagesEndRef} className="h-4" />
        </div>

        <div className="w-full bg-[var(--color-antigravity-panel)]/40 backdrop-blur-xl border-t border-[var(--color-antigravity-border)] flex flex-col relative z-20">
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

          {queriesFileExists && loadedQueries.length > 0 && (
            <div className="px-3 py-2 border-b border-white/[0.02] bg-white/[0.01] flex flex-col gap-1.5 select-none">
              <div className="flex items-center justify-between">
                <span className="text-[8px] font-bold uppercase tracking-wider text-zinc-500 font-mono">
                  Query Pipeline Execution
                </span>
                <span className="text-[8px] font-mono text-zinc-500">
                  {currentQueryIndex + 1} of {loadedQueries.length}
                </span>
              </div>

              <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar pb-1 pt-0.5">
                {loadedQueries.map((query, index) => {
                  const isDone = index < currentQueryIndex;
                  const isCurrent = index === currentQueryIndex;

                  return (
                    <div
                      key={index}
                      className={`flex items-center gap-1.5 shrink-0 px-2.5 py-1 rounded-md border transition-all ${
                        isCurrent
                          ? "bg-[var(--color-antigravity-highlight)] border-[var(--color-antigravity-accent)]/30 text-[var(--color-antigravity-accent)]"
                          : isDone
                            ? "bg-emerald-500/5 border-emerald-500/10 text-emerald-400 opacity-60"
                            : "bg-white/[0.01] border-white/[0.04] text-zinc-500 opacity-40"
                      }`}
                    >
                      <div className="relative flex items-center justify-center shrink-0">
                        <div
                          className={`w-1.5 h-1.5 rounded-full ${
                            isDone
                              ? "bg-emerald-500"
                              : isCurrent
                                ? "bg-[var(--color-antigravity-accent)]"
                                : "bg-zinc-700"
                          }`}
                        />
                      </div>

                      <span className="text-[9px] font-mono max-w-[120px] truncate leading-none">
                        {query.length > 25
                          ? `${query.substring(0, 25)}...`
                          : query}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <form
            onSubmit={handleSendManualMessage}
            className="px-3 pb-2 pt-2.5 flex items-end gap-2 bg-[var(--vscode-sideBar-background,rgba(0,0,0,0.05))] relative z-20 border-b border-white/[0.03]"
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendManualMessage(e);
                }
              }}
              placeholder="Type a custom query..."
              className="flex-grow bg-[var(--vscode-input-background,rgba(0,0,0,0.15))] border border-[var(--vscode-input-border,var(--color-antigravity-border))] rounded-md px-3 py-1.5 text-[11px] font-mono text-[var(--vscode-input-foreground,var(--color-antigravity-text-primary))] placeholder:text-[var(--vscode-input-placeholderForeground,var(--color-antigravity-text-secondary))]/55 outline-none focus:border-[var(--color-antigravity-accent)]/30 transition-all resize-none min-h-[30px] max-h-[160px]"
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="h-[30px] px-3.5 rounded-md bg-[var(--color-antigravity-accent)] hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed text-white text-[10px] font-mono uppercase tracking-widest transition-all shrink-0 cursor-pointer"
            >
              Send
            </button>
          </form>

          <div className="p-1.5 flex items-center gap-1.5 w-full">
            <div
              onClick={queriesFileExists ? undefined : handleCreateQueriesFile}
              className={`flex-grow flex items-center justify-between bg-white/[0.02] border border-[var(--color-antigravity-border)] rounded-md px-2 py-1 h-[28px] transition-all min-w-0 ${
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
                  <span className="text-[9px] text-[var(--color-antigravity-text-secondary)] opacity-45 shrink-0 font-mono">
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

            <button
              type="button"
              onClick={handlePlayPause}
              disabled={!queriesFileExists || loadedQueries.length === 0}
              className={`h-[28px] px-2.5 rounded-md border transition-all flex items-center justify-center shrink-0 cursor-pointer ${
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

      {/* Render Workspace Error overlay if error is present */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/85 z-50 backdrop-blur-xl">
          <div className="border border-red-500/30 bg-red-500/5 rounded-xl p-8 max-w-md w-full shadow-2xl flex flex-col gap-6 text-center">
            <div className="flex flex-col gap-2">
              <h3 className="text-red-400 font-bold text-lg">
                Error Encountered
              </h3>
              <p className="text-[var(--color-antigravity-text-secondary)] font-mono text-xs leading-relaxed">
                {error}
              </p>
            </div>
            <button
              onClick={() => setError(null)}
              className="text-zinc-500 hover:text-zinc-300 text-[10px] uppercase tracking-widest"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Clone Modal Overlay */}
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
                  className="w-full bg-[var(--vscode-input-background,rgba(0,0,0,0.15))] border border-[var(--vscode-input-border,var(--color-antigravity-border))] rounded px-3 py-2 text-[12px] text-[var(--vscode-input-foreground,var(--color-antigravity-text-primary))] placeholder:text-[var(--vscode-input-placeholderForeground,var(--color-antigravity-text-secondary))]/50 outline-none focus:border-[var(--color-antigravity-accent)]/45 transition-all font-mono"
                  placeholder="./"
                />
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => setShowCloneModal(false)}
                  className="flex-1 px-4 py-2 rounded bg-white/5 hover:bg-white/10 text-[10px] text-zinc-400 uppercase tracking-widest transition-all border border-[var(--color-antigravity-border)]"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setIsCloning(true);
                    let finalUrl = repoUrl.trim();
                    if (!finalUrl.includes("://")) {
                      finalUrl = `https://github.com/${finalUrl}`;
                    }
                    if (vscode) {
                      vscode.postMessage({
                        command: "cloneRepo",
                        url: finalUrl,
                        path: clonePath,
                      });
                    }
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
