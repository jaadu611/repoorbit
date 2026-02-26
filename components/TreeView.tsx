/**
 * almost completely ai made file
 * idk whats happening here but probably shouldnt touch
 * it takes in data from props and convert it into the heat map
 */

"use client";

import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import * as d3 from "d3";
import {
  GitBranch,
  FileCode2,
  X,
  GitCommit,
  Hash,
  Layers,
  HardDrive,
  Code2,
  GripHorizontal,
  ChevronLeft,
  Calendar,
  FolderTree,
} from "lucide-react";
import { FileNode } from "@/modes/TreeMapper";
import { EXT_GROUPS, ICON_SVGS } from "@/constants/treeView.constants";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TreeNode {
  id: string;
  name: string;
  type: "root" | "folder" | "file";
  ext: string;
  size: number;
  details?: {
    name: string;
    fullName: string;
    owner: string;
    avatar: string;
    description: string;
    url: string;
    homepage: string;
    stars: number;
    forks: number;
    watchers: number;
    subscribers: number;
    openIssues: number;
    size: number;
    createdAt: string;
    updatedAt: string;
    pushedAt: string;
    language: string;
    topics: string[];
    license: string;
    defaultBranch: string;
    hasWiki: boolean;
    hasPages: boolean;
    hasIssues: boolean;
    hasProjects: boolean;
    hasDiscussions: boolean;
    visibility: string;
  };
  fileDetails?: {
    depth: number;
    path: string;
    isLarge: boolean;
    percentOfTotal: string;
    branchWeight: number;
  };
  originalChildren: TreeNode[];
  children?: TreeNode[] | null;
}

function fileColor(ext: string) {
  for (const g of EXT_GROUPS) if (g.exts.includes(ext)) return g;
  return EXT_GROUPS[EXT_GROUPS.length - 1];
}

function nodeRadius(n: TreeNode) {
  if (n.type === "root") return 20;
  if (n.type === "folder") return 13;
  return 6;
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function iconKey(d: TreeNode): string {
  if (d.type === "root") return "root";
  if (d.type === "folder")
    return d.children && d.children.length > 0 ? "folderOpen" : "folder";

  const e = d.ext?.toLowerCase();
  const n = d.name.toLowerCase();

  if (["ts", "tsx", "cts", "mts"].includes(e)) return "ts";
  if (["js", "jsx", "mjs", "cjs"].includes(e)) return "js";
  if (["py", "pyw", "pyc", "ipynb", "pyd"].includes(e)) return "py";
  if (["go"].includes(e)) return "go";
  if (["rs", "rlib"].includes(e)) return "rs";
  if (["java", "jar", "class", "jsp"].includes(e)) return "java";
  if (["cpp", "cc", "cxx", "h", "hpp", "hh", "c"].includes(e)) return "cpp";
  if (["rb", "erb"].includes(e)) return "rb";
  if (["php", "phtml", "php4", "php5"].includes(e)) return "php";
  if (["cs", "cshtml"].includes(e)) return "csharp";
  if (["kt", "kts"].includes(e)) return "kotlin";
  if (["swift"].includes(e)) return "swift";

  if (
    [
      "json",
      "yaml",
      "yml",
      "toml",
      "env",
      "ini",
      "lock",
      "xml",
      "csv",
      "tsv",
    ].includes(e)
  )
    return "json";
  if (["tf", "tfvars", "hcl", "tfstate"].includes(e)) return "tf";
  if (["sql", "psql", "mysql", "sqlite", "db"].includes(e)) return "sql";
  if (["dockerfile", "containerfile"].includes(e) || n.includes("dockerfile"))
    return "docker";
  if (["yaml", "yml"].includes(e) && (n.includes("k8s") || n.includes("kube")))
    return "k8s";

  if (["css", "scss", "sass", "less", "styl"].includes(e)) return "css";
  if (["html", "htm", "xhtml", "aspx"].includes(e)) return "html";
  if (["vue"].includes(e)) return "vue";
  if (["svelte"].includes(e)) return "svelte";

  if (["md", "mdx", "txt", "rst", "pdf", "doc", "docx"].includes(e))
    return "md";

  if (
    [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "svg",
      "webp",
      "ico",
      "avif",
      "bmp",
      "tiff",
    ].includes(e)
  )
    return "img";

  if (["sh", "bash", "zsh", "fish", "bat", "ps1", "cmd", "awk"].includes(e))
    return "sh";
  if (["wasm"].includes(e)) return "wasm";

  return "other";
}

// ─── Build tree ───────────────────────────────────────────────────────────────

function buildTree(nodes: any[], repoTotalSize = 0, depth = 1): TreeNode[] {
  return nodes.map((n) => {
    const ext = n.name.includes(".")
      ? (n.name.split(".").pop()?.toLowerCase() ?? "")
      : "";
    const children = n.children
      ? buildTree(n.children, repoTotalSize, depth + 1)
      : [];
    const calculatedSize =
      n.type === "folder"
        ? children.reduce((acc, child) => acc + child.size, 0)
        : n.size || 0;
    const totalNestedItems =
      n.type === "folder"
        ? children.reduce((acc, child) => {
            const w = (child as any).fileDetails?.branchWeight || 0;
            return acc + 1 + w;
          }, 0)
        : 0;
    return {
      id: n.path,
      name: n.name,
      type: n.type === "folder" ? "folder" : "file",
      ext,
      size: calculatedSize,
      fileDetails: {
        depth,
        path: n.path,
        isLarge: calculatedSize > 1024 * 500,
        branchWeight: totalNestedItems,
      },
      originalChildren: children,
      children: null,
    } as unknown as TreeNode;
  });
}

function collectExts(rootNode: FileNode): Set<string> {
  const exts = new Set<string>();
  const walk = (n: FileNode) => {
    if (n.type === "file" && n.name.includes("."))
      exts.add(n.name.split(".").pop()?.toLowerCase() ?? "");
    if (n.children) n.children.forEach(walk);
  };
  walk(rootNode);
  return exts;
}

const NODE_SEP = 48;
const LEVEL_SEP = 140;
const MIN_PANE_PX = 120; // minimum px for each pane

// ─── Component ────────────────────────────────────────────────────────────────

export default function TreeView({
  data,
  filter,
}: {
  data: FileNode;
  filter: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null); // the outer wrapper — used to measure total height
  const transformRef = useRef({ x: 0, y: 60, k: 1 });
  const rootNodeRef = useRef<TreeNode | null>(null);
  const drawRef = useRef<() => void>(() => {});
  const rawCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const tintCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map());

  const [iconsReady, setIconsReady] = useState(false);
  const [, forceRender] = useState(0);
  const [legendOpen, setLegendOpen] = useState(false);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    node: TreeNode;
  } | null>(null);
  const [activeFile, setActiveFile] = useState<{
    node: TreeNode;
    content: string;
    history?: any;
  } | null>(null);

  // ── Splitter: topPx is the pixel height of the tree pane ──
  const [topPx, setTopPx] = useState<number | null>(null); // null = use default split
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartTop = useRef(0);

  const presentGroups = useMemo(() => {
    if (!data) return [];
    const exts = collectExts(data);
    return EXT_GROUPS.filter((g) =>
      g.exts.length === 0
        ? [...exts].some(
            (e) => !EXT_GROUPS.slice(0, -1).some((g2) => g2.exts.includes(e)),
          )
        : g.exts.some((e) => exts.has(e)),
    );
  }, [data]);

  // When inspector opens, default to 50/50 split
  useEffect(() => {
    if (activeFile && topPx === null && rootRef.current) {
      setTopPx(rootRef.current.clientHeight / 2);
    }
    if (!activeFile) setTopPx(null);
  }, [activeFile]);

  // ── Drag handlers ────────────────────────────────────────────────────────
  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      dragStartY.current = e.clientY;
      dragStartTop.current = topPx ?? 0;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [topPx],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDragging.current || !rootRef.current) return;
      const totalH = rootRef.current.clientHeight;
      const delta = e.clientY - dragStartY.current;
      const next = Math.min(
        totalH - MIN_PANE_PX,
        Math.max(MIN_PANE_PX, dragStartTop.current + delta),
      );
      setTopPx(next);
    };
    const onUp = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // ── Load icons ────────────────────────────────────────────────────────────
  useEffect(() => {
    const SIZE = 512;
    const raw = rawCacheRef.current;
    let loaded = 0;
    const total = Object.keys(ICON_SVGS).length;
    Object.entries(ICON_SVGS).forEach(([key, paths]) => {
      const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
      const blob = new Blob([svgStr], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        raw.set(key, img);
        URL.revokeObjectURL(url);
        if (++loaded === total) setIconsReady(true);
      };
      img.src = url;
    });
  }, []);

  // ── Tint cache ────────────────────────────────────────────────────────────
  const getTinted = useCallback(
    (key: string, color: string): HTMLCanvasElement | null => {
      const cacheKey = `${key}|${color}`;
      if (tintCacheRef.current.has(cacheKey))
        return tintCacheRef.current.get(cacheKey)!;
      const src = rawCacheRef.current.get(key);
      if (!src) return null;
      const SIZE = 512;
      const oc = document.createElement("canvas");
      oc.width = SIZE;
      oc.height = SIZE;
      const octx = oc.getContext("2d")!;
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = "high";
      octx.drawImage(src, 0, 0, SIZE, SIZE);
      octx.globalCompositeOperation = "source-in";
      octx.fillStyle = color;
      octx.fillRect(0, 0, SIZE, SIZE);
      tintCacheRef.current.set(cacheKey, oc);
      return oc;
    },
    [],
  );

  // ── Build tree ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!data) return;
    const children = data.children ? buildTree(data.children) : [];
    rootNodeRef.current = {
      ...data,
      id: data.path || "__root__",
      type: "root",
      ext: "",
      details: data.details,
      originalChildren: children,
      children,
    } as unknown as TreeNode;
    forceRender((n) => n + 1);
  }, [data]);

  // ── Layout ────────────────────────────────────────────────────────────────
  const computeLayout = useCallback(() => {
    const root = rootNodeRef.current;
    if (!root) return null;
    const h = d3.hierarchy<TreeNode>(root, (d) => d.children ?? null);
    d3
      .tree<TreeNode>()
      .nodeSize([NODE_SEP, LEVEL_SEP])
      .separation(() => 1.5)(h);
    return h;
  }, []);

  // ── Draw ──────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { x, y, k } = transformRef.current;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const hierarchy = computeLayout();
    if (!hierarchy) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);

    for (const link of hierarchy.links()) {
      const sx = Math.round(link.source.x ?? 0),
        sy = Math.round(link.source.y ?? 0);
      const tx = Math.round(link.target.x ?? 0),
        ty = Math.round(link.target.y ?? 0);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      const midY = Math.round(sy + (ty - sy) * 0.5);
      ctx.bezierCurveTo(sx, midY, tx, midY, tx, ty);
      ctx.strokeStyle =
        link.target.data.type === "folder" ? "#4b6080" : "#374f68";
      ctx.lineWidth = link.target.data.type === "folder" ? 1.2 : 0.8;
      ctx.lineCap = "butt";
      ctx.stroke();
    }

    for (const node of hierarchy.descendants()) {
      const nx = node.x ?? 0,
        ny = node.y ?? 0;
      const d = node.data;
      const r = nodeRadius(d);
      const key = iconKey(d);

      if (d.type === "root") {
        const grad = ctx.createRadialGradient(nx, ny, r - 2, nx, ny, r + 12);
        grad.addColorStop(0, hexToRgba("#60a5fa", 0.25));
        grad.addColorStop(1, hexToRgba("#60a5fa", 0));
        ctx.beginPath();
        ctx.arc(nx, ny, r + 12, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(nx, ny, r, 0, Math.PI * 2);
        ctx.fillStyle = "#0c1628";
        ctx.fill();
        ctx.strokeStyle = "#60a5fa";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        const tinted = getTinted(key, "#60a5fa");
        if (tinted)
          ctx.drawImage(tinted, nx - r * 0.6, ny - r * 0.6, r * 1.2, r * 1.2);
        ctx.fillStyle = "#bfdbfe";
        ctx.font = "bold 9px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(
          d.name.length > 18 ? d.name.slice(0, 17) + "…" : d.name,
          nx,
          ny + r + 5,
        );
      } else if (d.type === "folder") {
        const isCollapsed = d.originalChildren.length > 0 && !d.children;
        const accent = isCollapsed ? "#cbd5e1" : "#94a3b8";
        ctx.beginPath();
        ctx.arc(nx, ny, r, 0, Math.PI * 2);
        ctx.fillStyle = isCollapsed ? "#1a2640" : "#111827";
        ctx.fill();
        ctx.strokeStyle = accent;
        ctx.lineWidth = isCollapsed ? 1.5 : 1.0;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(nx, ny, r * 0.72, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(accent, 0.12);
        ctx.fill();
        const tinted = getTinted(key, accent);
        if (tinted)
          ctx.drawImage(tinted, nx - r * 0.6, ny - r * 0.6, r * 1.2, r * 1.2);
        ctx.fillStyle = isCollapsed ? "#e2e8f0" : "#94a3b8";
        ctx.font = `${isCollapsed ? "bold " : ""}8px monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const folderLabel =
          d.name.length > 12 ? d.name.slice(0, 11) + "…" : d.name;

        ctx.fillText(folderLabel, nx, ny + r + 4);
        if (isCollapsed && d.originalChildren.length > 0) {
          const label = `+${d.originalChildren.length}`;
          const bw = label.length * 6 + 10;
          ctx.fillStyle = "rgba(203,213,225,0.12)";
          ctx.beginPath();
          ctx.roundRect(nx - bw / 2, ny + r + 17, bw, 12, 3);
          ctx.fill();
          ctx.fillStyle = "#94a3b8";
          ctx.font = "bold 7px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(label, nx, ny + r + 23);
        }
      } else {
        const { color } = fileColor(d.ext);
        const isLargeZoom = k > 0.4;
        const radius = isLargeZoom ? r * 1.8 : r;
        ctx.beginPath();
        ctx.arc(nx, ny, radius, 0, Math.PI * 2);
        ctx.fillStyle = "#0d1521";
        ctx.fill();
        ctx.strokeStyle = hexToRgba(color, 0.7);
        ctx.lineWidth = 0.9;
        ctx.stroke();
        if (isLargeZoom) {
          ctx.beginPath();
          ctx.arc(nx, ny, radius * 0.75, 0, Math.PI * 2);
          ctx.fillStyle = hexToRgba(color, 0.18);
          ctx.fill();
          const tinted = getTinted(key, color);
          if (tinted) {
            const is = radius * 1.15;
            ctx.drawImage(tinted, nx - is / 2, ny - is / 2, is, is);
          }
        } else {
          ctx.beginPath();
          ctx.arc(nx, ny, radius * 0.6, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
        }
        if (k > 0.9) {
          ctx.fillStyle = hexToRgba(color, 0.9);
          ctx.font = "7px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(
            d.name.length > 16 ? d.name.slice(0, 15) + "…" : d.name,
            nx,
            ny + radius + 4,
          );
        }
      }
    }
    ctx.restore();
  }, [computeLayout, getTinted]);

  useEffect(() => {
    drawRef.current = draw;
  }, [draw]);
  useEffect(() => {
    draw();
  }, [iconsReady, draw]);

  // ── Canvas init ───────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = treeContainerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const updateSize = () => {
      const dpr = window.devicePixelRatio || 1;
      const W = container.clientWidth,
        H = container.clientHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRef.current();
    };
    const ro = new ResizeObserver(updateSize);
    ro.observe(container);
    updateSize();

    transformRef.current = { x: container.clientWidth / 2, y: 60, k: 1 };

    const zoom = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.05, 10])
      .on("zoom", (e) => {
        transformRef.current = {
          x: e.transform.x,
          y: e.transform.y,
          k: e.transform.k,
        };
        drawRef.current();
      })
      .filter(
        (event) => (!event.ctrlKey || event.type === "wheel") && !event.button,
      );

    const sel = d3.select(canvas);
    sel.call(zoom);
    sel.on("wheel.zoom", null);
    sel.on("dblclick.zoom", null);
    sel.on(
      "wheel",
      (event: WheelEvent) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.ctrlKey) {
          sel.call(
            zoom.scaleBy,
            Math.pow(2, -event.deltaY * 0.01),
            d3.pointer(event),
          );
        } else {
          const t = d3.zoomTransform(canvas);
          sel.call(
            zoom.transform,
            t.translate(-event.deltaX / t.k, -event.deltaY / t.k),
          );
        }
      },
      { passive: false },
    );

    sel.call(
      zoom.transform,
      d3.zoomIdentity.translate(container.clientWidth / 2, 60),
    );
    return () => ro.disconnect();
  }, []);

  // ── Hit test ──────────────────────────────────────────────────────────────
  const hitTest = useCallback(
    (ex: number, ey: number): TreeNode | null => {
      const h = computeLayout();
      if (!h) return null;
      const { x, y, k } = transformRef.current;
      const mx = (ex - x) / k,
        my = (ey - y) / k;
      for (const node of h.descendants()) {
        const d = node.data;
        const threshold = d.type === "root" ? 28 : nodeRadius(d) + 8;
        if (Math.hypot((node.x ?? 0) - mx, (node.y ?? 0) - my) < threshold)
          return d;
      }
      return null;
    },
    [computeLayout],
  );

  const onClick = useCallback(
    async (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current!.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Use your hitTest logic here to find the 'hit'
      const hit = hitTest(x, y);

      if (!hit) return;

      if (hit.type === "folder") {
        hit.children = hit.children ? null : hit.originalChildren;
        drawRef.current();
        forceRender((n) => n + 1);
      } else if (hit.type === "file") {
        const owner = data.details?.owner;
        const repo = data.details?.name;

        if (!owner || !repo) {
          console.error("Repository details missing from data prop");
          return;
        }

        // Important: Use the NEXT_PUBLIC token for client-side fetching
        const token = process.env.NEXT_PUBLIC_GITHUB_TOKEN;

        const headers = {
          Accept: "application/vnd.github.v3+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        };

        try {
          // ENCODE the path to handle spaces like "Museum of Candies"
          const encodedPath = encodeURIComponent(hit.id);

          const [contentRes, historyRes] = await Promise.all([
            fetch(
              `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`,
              { headers },
            ),
            fetch(
              `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodedPath}&per_page=1`,
              { headers },
            ),
          ]);

          if (!contentRes.ok) {
            const errorData = await contentRes.json();
            throw new Error(
              errorData.message || `Status: ${contentRes.status}`,
            );
          }

          const contentData = await contentRes.json();
          const historyData = await historyRes.json();

          // Handle binary files (like images) or empty files
          let rawContent = "";
          if (contentData.encoding === "base64") {
            rawContent = atob(contentData.content.replace(/\n/g, ""));
          } else {
            rawContent =
              "// Non-text or large file detected. Cannot preview raw content.";
          }

          setActiveFile({
            node: hit,
            content: rawContent,
            history: historyData[0] || null,
          });
        } catch (err: any) {
          console.error("GitHub API Error:", err.message);
          setActiveFile({
            node: hit,
            content: `⚠️ API Error: ${err.message}\n\nPossible causes:\n1. Rate limit exceeded (check token).\n2. File is too large for the 'contents' API.\n3. Path contains special characters not encoded.`,
            history: null,
          });
        }
      }
    },
    [hitTest, data],
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current!.getBoundingClientRect();
      const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
      setTooltip(
        hit
          ? { x: e.clientX - rect.left, y: e.clientY - rect.top, node: hit }
          : null,
      );
      if (canvasRef.current)
        canvasRef.current.style.cursor =
          hit?.type === "folder" || hit?.type === "file"
            ? "pointer"
            : "default";
    },
    [hitTest],
  );

  const sidebarWidth = legendOpen ? 280 : 48;
  const fc = activeFile ? fileColor(activeFile.node.ext) : null;

  // Compute pixel heights for the two panes
  const treeH = activeFile && topPx !== null ? topPx : undefined;
  const inspH =
    activeFile && topPx !== null && rootRef.current
      ? rootRef.current.clientHeight - topPx - 6 // 6 = divider height
      : undefined;

  return (
    // KEY: outer div is position:relative with overflow:hidden.
    // The parent (workspace page) gives this component h-full, so it fills the slot exactly.
    // We do NOT use flex-col + percentages here — we use absolute positioning for each pane
    // so they can never push each other out of the container.
    <div
      ref={rootRef}
      className="relative w-full h-full bg-[#080d16] overflow-hidden"
    >
      <div
        ref={treeContainerRef}
        className="absolute left-0 right-0 top-0 overflow-hidden"
        style={{ bottom: activeFile ? `calc(100% - ${topPx ?? 0}px)` : 0 }}
      >
        <div
          className="absolute right-0 top-0 bottom-0 z-10 flex flex-col border-l border-slate-700/50 bg-[#080d16]/95 backdrop-blur-sm transition-all duration-200 overflow-hidden"
          style={{ width: sidebarWidth }}
        >
          <div
            className={`shrink-0 p-2 border-b border-slate-700/50 flex items-center ${legendOpen ? "justify-between" : "justify-center"}`}
          >
            {legendOpen && (
              <div className="flex items-center gap-2 pl-1">
                <GitBranch size={12} className="text-slate-400" />
                <span className="text-[11px] font-mono uppercase tracking-[0.15em] text-slate-400 whitespace-nowrap">
                  File Types
                </span>
              </div>
            )}
            <button
              onClick={() => setLegendOpen((v) => !v)}
              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-white/10 transition-colors text-slate-400 hover:text-slate-200"
            >
              <ChevronLeft
                size={14}
                className={`transition-transform duration-200 ${legendOpen ? "rotate-180" : ""}`}
              />
            </button>
          </div>

          {legendOpen && (
            <div className="flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-0.5">
              {presentGroups.map(({ label, color, exts, icon: Icon }) => (
                <div
                  key={label}
                  className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/6 transition-colors"
                >
                  <div
                    className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
                    style={{ background: color + "28" }}
                  >
                    <Icon size={15} style={{ color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-[13px] font-semibold leading-tight"
                      style={{ color }}
                    >
                      {label}
                    </div>
                    <div
                      className="text-[10px] leading-tight truncate mt-0.5 font-mono"
                      style={{ color: color + "aa" }}
                    >
                      {exts.length > 0
                        ? exts
                            .slice(0, 5)
                            .map((e) => `.${e}`)
                            .join(" ") + (exts.length > 5 ? " …" : "")
                        : "others"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Canvas */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 cursor-default"
          style={{ right: sidebarWidth }}
          onClick={onClick}
          onMouseMove={onMouseMove}
          onMouseLeave={() => {
            setTooltip(null);
            if (canvasRef.current) canvasRef.current.style.cursor = "default";
          }}
        />

        {/* Tooltip */}
        {tooltip && (
          <div
            className="absolute z-20 pointer-events-none px-4 py-3 rounded-xl font-mono shadow-2xl border backdrop-blur-md"
            style={{
              left: tooltip.x + 20,
              top: Math.min(
                tooltip.y - 10,
                (treeContainerRef.current?.clientHeight ?? 400) - 280,
              ),
              background: "rgba(10, 18, 32, 0.97)",
              borderColor:
                tooltip.node.type === "root"
                  ? "#60a5fa"
                  : "rgba(100, 116, 139, 0.55)",
            }}
          >
            {tooltip.node.type === "root" ? (
              <div className="min-w-[280px]">
                <div className="flex items-center gap-3 mb-4">
                  {tooltip.node.details?.avatar && (
                    <img
                      src={tooltip.node.details.avatar}
                      className="w-10 h-10 rounded-xl border border-white/15"
                      alt="avatar"
                    />
                  )}
                  <div>
                    <div className="text-[15px] text-white font-bold">
                      {tooltip.node.name}
                    </div>
                    <div className="text-[11px] text-blue-400">
                      @{tooltip.node.details?.owner} ·{" "}
                      {tooltip.node.details?.visibility}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {[
                    {
                      label: "Stars",
                      value: `★ ${tooltip.node.details?.stars?.toLocaleString()}`,
                      color: "text-yellow-400",
                    },
                    {
                      label: "Forks",
                      value: tooltip.node.details?.forks?.toLocaleString(),
                      color: "text-blue-400",
                    },
                    {
                      label: "Issues",
                      value: tooltip.node.details?.openIssues,
                      color: "text-red-400",
                    },
                  ].map((s) => (
                    <div
                      key={s.label}
                      className="bg-white/5 rounded-lg p-2 text-center border border-white/5"
                    >
                      <div className={`${s.color} text-[12px] font-bold`}>
                        {s.value}
                      </div>
                      <div className="text-[9px] text-slate-500 uppercase tracking-tight mt-0.5">
                        {s.label}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="space-y-1.5 border-t border-slate-800 pt-3">
                  {[
                    {
                      k: "Language",
                      v: tooltip.node.details?.language || "Mixed",
                      c: "text-orange-400",
                    },
                    {
                      k: "Size",
                      v: `${Math.round((tooltip.node.details?.size ?? 0) / 1024)} MB`,
                      c: "text-slate-300",
                    },
                    {
                      k: "Last Push",
                      v: tooltip.node.details?.pushedAt
                        ? new Date(
                            tooltip.node.details.pushedAt,
                          ).toLocaleDateString()
                        : "—",
                      c: "text-slate-300",
                    },
                  ].map((r) => (
                    <div key={r.k} className="flex justify-between text-[11px]">
                      <span className="text-slate-500">{r.k}</span>
                      <span className={`${r.c} font-medium`}>{r.v}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="min-w-[220px] space-y-2.5">
                <div>
                  <div className="text-[13px] text-white font-bold">
                    {tooltip.node.name}
                  </div>
                  <div className="text-[10px] text-blue-400 opacity-80 truncate max-w-[240px]">
                    {tooltip.node.fileDetails?.path}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-slate-700 pt-2.5">
                  <div>
                    <div className="text-[9px] text-slate-500 uppercase mb-0.5">
                      Size
                    </div>
                    <div className="text-[12px] text-slate-200 font-bold">
                      {tooltip.node.size > 1024 * 1024
                        ? `${(tooltip.node.size / (1024 * 1024)).toFixed(2)} MB`
                        : `${(tooltip.node.size / 1024).toFixed(2)} KB`}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] text-slate-500 uppercase mb-0.5">
                      Depth
                    </div>
                    <div className="text-[12px] text-slate-200 font-bold">
                      Level {tooltip.node.fileDetails?.depth}
                    </div>
                  </div>
                  {tooltip.node.type === "folder" && (
                    <div>
                      <div className="text-[9px] text-slate-500 uppercase mb-0.5">
                        Children
                      </div>
                      <div className="text-[12px] text-blue-300 font-bold">
                        {tooltip.node.originalChildren.length}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ══ DRAG DIVIDER ══ */}
      {activeFile && topPx !== null && (
        <div
          className="absolute left-0 right-0 z-30 flex items-center justify-center group"
          style={{ top: topPx, height: 6, cursor: "row-resize" }}
          onMouseDown={onDragStart}
        >
          {/* visible bar */}
          <div className="absolute inset-0 bg-slate-700/60 group-hover:bg-blue-500/50 transition-colors" />
          {/* grip dots */}
          <div className="relative z-10 flex items-center gap-1 px-3 py-0.5 bg-slate-800 border border-slate-600 group-hover:border-blue-500/60 rounded-full transition-colors pointer-events-none">
            <GripHorizontal
              size={12}
              className="text-slate-500 group-hover:text-blue-400 transition-colors"
            />
          </div>
        </div>
      )}

      {/* ══ INSPECTOR PANE ══ */}
      {activeFile && topPx !== null && (
        <div
          className="absolute left-0 right-0 bottom-0 flex flex-col bg-[#080d16] overflow-hidden"
          style={{ top: topPx + 6 }}
        >
          {/* Header */}
          <div
            className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-slate-800"
            style={{ background: fc ? hexToRgba(fc.color, 0.07) : "#0d1521" }}
          >
            <div
              className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center"
              style={{
                background: fc ? hexToRgba(fc.color, 0.18) : "#1e293b",
                border: `1px solid ${fc?.color ?? "#475569"}35`,
              }}
            >
              {fc && <fc.icon size={15} style={{ color: fc.color }} />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-bold text-white font-mono truncate leading-tight">
                {activeFile.node.name}
              </div>
              <div className="text-[10px] text-slate-500 font-mono truncate">
                {activeFile.node.fileDetails?.path}
              </div>
            </div>
            <div className="hidden sm:flex items-center gap-2 shrink-0">
              <span className="text-[11px] font-mono text-slate-400 bg-slate-800 px-2.5 py-1 rounded-md border border-slate-700">
                {activeFile.content.split("\n").length} lines
              </span>
              <span className="text-[11px] font-mono text-slate-400 bg-slate-800 px-2.5 py-1 rounded-md border border-slate-700">
                {(activeFile.node.size / 1024).toFixed(1)} KB
              </span>
            </div>
            <button
              onClick={() => setActiveFile(null)}
              className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-white hover:bg-red-500/15 border border-slate-700 hover:border-red-500/40 transition-all"
            >
              <X size={14} />
            </button>
          </div>

          {/* Body: source + details */}
          <div className="flex flex-1 min-h-0">
            {/* Source */}
            <div
              className="flex flex-col border-r border-slate-800 overflow-hidden"
              style={{ width: "60%" }}
            >
              <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-slate-800/70 bg-slate-950/60">
                <Code2 size={12} className="text-slate-500" />
                <span className="text-[11px] font-mono font-bold text-slate-500 uppercase tracking-wider">
                  Source
                </span>
              </div>
              <div className="flex-1 overflow-auto bg-[#040710]">
                {/* REPLACE THE OLD <pre> WITH THIS */}
                <SyntaxHighlighter
                  language={activeFile.node.ext || "javascript"}
                  style={vscDarkPlus}
                  customStyle={{
                    margin: 0,
                    padding: "20px",
                    fontSize: "13px",
                    background: "transparent",
                    lineHeight: "1.6",
                  }}
                  showLineNumbers={true}
                  lineNumberStyle={{
                    minWidth: "3em",
                    paddingRight: "1em",
                    color: "#3b4252",
                    textAlign: "right",
                    userSelect: "none",
                  }}
                >
                  {activeFile.content}
                </SyntaxHighlighter>
              </div>
            </div>

            {/* Details */}
            <div
              className="flex flex-col overflow-auto bg-[#05080f]"
              style={{ width: "40%" }}
            >
              {activeFile.history && (
                <div className="shrink-0 p-4 border-b border-slate-800">
                  <div className="flex items-center gap-2 mb-2.5">
                    <GitCommit size={12} className="text-slate-500" />
                    <span className="text-[11px] font-mono font-bold text-slate-400 uppercase tracking-wider">
                      Last Commit
                    </span>
                  </div>
                  <div className="flex items-start gap-3 bg-slate-900/60 rounded-xl p-3.5 border border-slate-800">
                    {activeFile.history.author?.avatar_url && (
                      <img
                        src={activeFile.history.author.avatar_url}
                        className="w-9 h-9 rounded-lg border border-slate-700 shrink-0 mt-0.5"
                        alt="author"
                      />
                    )}
                    <div className="min-w-0 space-y-1">
                      <div className="relative group cursor-help">
                        <p className="text-[13px] text-slate-100 font-medium leading-snug line-clamp-2 cursor-default">
                          {activeFile.history.commit.message}
                        </p>

                        {/* tooltip */}
                        <div className="absolute z-50 cursor-default top-full left-0 mt-2 hidden group-hover:block p-2 bg-slate-900 border border-slate-700 rounded-lg shadow-xl text-[12px] text-slate-200 leading-normal animate-in fade-in zoom-in-95 duration-200">
                          {activeFile.history.commit.message}
                        </div>
                      </div>
                      <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5">
                        <span className="text-[12px] text-blue-400 font-semibold">
                          {activeFile.history.commit.author.name}
                        </span>
                        <span className="text-slate-600 text-[11px]">·</span>
                        <span className="text-[10px] text-slate-500 font-mono bg-slate-800/60 px-1.5 py-0.5 rounded">
                          {activeFile.history.sha?.slice(0, 8)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <Layers size={12} className="text-slate-500" />
                  <span className="text-[11px] font-mono font-bold text-slate-400 uppercase tracking-wider">
                    File Info
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    {
                      icon: HardDrive,
                      label: "Size",
                      value: `${(activeFile.node.size / 1024).toFixed(2)} KB`,
                      accent: activeFile.node.fileDetails?.isLarge
                        ? "#fb923c"
                        : "#60a5fa",
                    },
                    {
                      icon: Hash,
                      label: "Depth",
                      value: `Level ${activeFile.node.fileDetails?.depth}`,
                      accent: "#94a3b8",
                    },
                    {
                      icon: FileCode2,
                      label: "Extension",
                      value: activeFile.node.ext
                        ? `.${activeFile.node.ext}`
                        : "none",
                      accent: fc?.color ?? "#94a3b8",
                    },
                    {
                      icon: Calendar,
                      label: "Modified",
                      value: activeFile.history?.commit?.author?.date
                        ? new Date(
                            activeFile.history.commit.author.date,
                          ).toLocaleDateString()
                        : "Unknown",
                      accent: "#c084fc",
                    },
                    {
                      icon: FolderTree,
                      label: "Path",
                      value: activeFile.node.fileDetails?.path,
                      accent: "#94a3b8",
                      isFullWidth: true,
                    },
                  ].map((m) => (
                    <div
                      key={m.label}
                      className={`${m.isFullWidth ? "col-span-2" : "col-span-1"} bg-slate-900/70 border border-slate-700 rounded-xl p-3`}
                    >
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <m.icon size={10} style={{ color: m.accent }} />
                        <span className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">
                          {m.label}
                        </span>
                      </div>
                      <div
                        className="text-[13px] font-mono font-semibold truncate"
                        style={{ color: m.accent }}
                        title={m.value}
                      >
                        {m.value}
                      </div>
                    </div>
                  ))}
                  {activeFile.node.fileDetails?.isLarge && (
                    <div className="col-span-2 flex items-center gap-2.5 px-3 py-2.5 bg-orange-500/8 border border-orange-500/30 rounded-xl">
                      <div className="w-2 h-2 rounded-full bg-orange-400 shrink-0 animate-pulse" />
                      <span className="text-[11px] text-orange-300 font-medium">
                        Large file — exceeds 500 KB
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
