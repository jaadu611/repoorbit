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
  Hash,
  Layers,
  HardDrive,
  Code2,
  GripHorizontal,
  ChevronLeft,
  ChevronDown,
  Calendar,
  FolderTree,
  Zap,
  FileText,
  Terminal,
  Cpu,
  BarChart2,
  Box,
  Loader2,
  Users,
  History,
  Clock,
  User,
  Copy,
  ExternalLink,
} from "lucide-react";
import {
  RepoTreeEntry,
  FileNode,
  TreeNode,
  AnimatingNode,
  AnimatingLink,
} from "@/lib/types";
import { EXT_GROUPS, hasData, ICON_SVGS } from "@/constants/treeView.constants";
import { useSelectionStore } from "@/lib/store";
import Link from "next/link";

const ANIM_DURATION = 320;
const LINK_DURATION = 260;
const ANIM_EASING = (t: number) => 1 - Math.pow(1 - t, 3);
const LINK_EASING = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

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
  const e = d.ext?.toLowerCase() ?? "";
  const n = d.name.toLowerCase();
  if (n === "dockerfile" || n.startsWith("dockerfile.")) return "docker";
  if (
    (e === "yaml" || e === "yml") &&
    (n.includes("k8s") || n.includes("kube"))
  )
    return "k8s";
  for (const g of EXT_GROUPS) {
    if (g.exts.includes(e)) return g.svgKey;
  }
  return "other";
}

function computeMatchSet(
  hierarchy: d3.HierarchyNode<TreeNode>,
  filter: string,
): Set<string> {
  if (!filter.trim()) return new Set();
  const q = filter.trim().toLowerCase().replace(/^\./, "");
  const matched = new Set<string>();
  hierarchy.each((node) => {
    if (node.data.type === "root") matched.add(node.data.id);
  });
  hierarchy.each((node) => {
    const d = node.data;
    const nameMatch = d.name.toLowerCase().includes(q);
    const extMatch = d.ext?.toLowerCase().includes(q);
    const pathMatch = (d.fileDetails?.path ?? "").toLowerCase().includes(q);
    if (nameMatch || extMatch || pathMatch) {
      matched.add(d.id);
      let anc = node.parent;
      while (anc) {
        matched.add(anc.data.id);
        anc = anc.parent;
      }
    }
  });
  return matched;
}

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
      sha: n.sha ?? "",
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
const MIN_PANE_PX = 120;

function StatPill({
  icon: Icon,
  label,
  value,
  accent = "#64748b",
}: {
  icon: any;
  label: string;
  value: React.ReactNode;
  accent?: string;
}) {
  return (
    <div
      className="flex flex-col gap-1 rounded-xl px-2.5 py-2 border transition-all duration-300 hover:scale-[1.02] hover:shadow-lg hover:shadow-black/20"
      style={{
        background: `linear-gradient(135deg, ${hexToRgba(accent, 0.08)} 0%, ${hexToRgba(accent, 0.02)} 100%)`,
        borderColor: hexToRgba(accent, 0.15),
      }}
    >
      <div className="flex items-center gap-1.5 opacity-60">
        <Icon size={10} style={{ color: accent }} />
        <span
          className="text-[7px] font-bold uppercase tracking-[0.15em] leading-none"
          style={{ color: accent }}
        >
          {label}
        </span>
      </div>
      <div
        className="text-[12px] font-mono font-bold truncate leading-tight tracking-tight"
        style={{ color: accent }}
      >
        {value}
      </div>
    </div>
  );
}

function Badge({
  children,
  color = "#64748b",
}: {
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <span
      className="text-[9px] font-bold font-mono px-2 py-0.5 rounded-full border backdrop-blur-sm transition-colors"
      style={{
        color,
        background: hexToRgba(color, 0.12),
        borderColor: hexToRgba(color, 0.25),
      }}
    >
      {children}
    </span>
  );
}

export default function TreeView({
  data,
  filter,
}: {
  data: FileNode;
  filter: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef({ x: 0, y: 60, k: 1 });
  const rootNodeRef = useRef<TreeNode | null>(null);
  const drawRef = useRef<() => void>(() => {});
  const rawCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const tintCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map());

  const animatingNodesRef = useRef<Map<string, AnimatingNode>>(new Map());
  const animatingLinksRef = useRef<Map<string, AnimatingLink>>(new Map());
  const rafRef = useRef<number | null>(null);
  const isAnimatingRef = useRef(false);

  const layoutCacheRef = useRef<d3.HierarchyPointNode<TreeNode> | null>(null);
  const filteredLayoutCacheRef = useRef<d3.HierarchyPointNode<TreeNode> | null>(
    null,
  );
  const matchSetCacheRef = useRef<Set<string>>(new Set());
  const lastFilterRef = useRef<string>("");

  const setSelection = useSelectionStore((state) => state.setSelection);
  const setFolderContext = useSelectionStore((state) => state.setFolderContext);
  const setFileContext = useSelectionStore((state) => state.setFileContext);

  const storeFileContext = useSelectionStore((s) => s.selection.fileContext);
  const storeFolderContext = useSelectionStore(
    (s) => s.selection.folderContext,
  );
  const storeRepoContext = useSelectionStore((s) => s.selection.repoContext);

  const [iconsReady, setIconsReady] = useState(false);
  const [, forceRender] = useState(0);
  const [legendOpen, setLegendOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    node: TreeNode;
  } | null>(null);
  const [activeFile, setActiveFile] = useState<{
    node: TreeNode;
    content: string;
    imageDataUrl?: string;
    history?: any;
    loading?: boolean;
    error?: string;
  } | null>(null);

  const [topPx, setTopPx] = useState<number | null>(null);
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

  useEffect(() => {
    if (activeFile && topPx === null && rootRef.current)
      setTopPx(rootRef.current.clientHeight / 2);
    if (!activeFile) setTopPx(null);
  }, [activeFile]);

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
    layoutCacheRef.current = null;
    filteredLayoutCacheRef.current = null;
    matchSetCacheRef.current = new Set();
    lastFilterRef.current = "";
    forceRender((n) => n + 1);
  }, [data]);

  const computeLayout = useCallback(
    (matchSet?: Set<string>) => {
      const root = rootNodeRef.current;
      if (!root) return null;
      if (!matchSet && layoutCacheRef.current) return layoutCacheRef.current;
      if (
        matchSet &&
        filteredLayoutCacheRef.current &&
        lastFilterRef.current === filter
      )
        return filteredLayoutCacheRef.current;
      const h = d3.hierarchy<TreeNode>(root, (d) => {
        const kids = d.children ?? null;
        if (!kids || !matchSet) return kids;
        const filtered = kids.filter((c) => matchSet.has(c.id));
        return filtered.length > 0 ? filtered : null;
      });
      const hp = d3
        .tree<TreeNode>()
        .nodeSize([NODE_SEP, LEVEL_SEP])
        .separation(() => 1.5)(h);
      if (!matchSet) layoutCacheRef.current = hp;
      else {
        filteredLayoutCacheRef.current = hp;
        lastFilterRef.current = filter;
      }
      return hp;
    },
    [filter],
  );

  const stopAnim = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    isAnimatingRef.current = false;
  }, []);

  const startAnimLoop = useCallback(() => {
    if (isAnimatingRef.current) return;
    isAnimatingRef.current = true;
    const tick = () => {
      const now = performance.now();
      let stillGoing = false;
      for (const [id, anim] of animatingNodesRef.current) {
        const elapsed = now - anim.born;
        const t = Math.min(1, elapsed / ANIM_DURATION);
        const e = anim.closing ? 1 - ANIM_EASING(t) : ANIM_EASING(t);
        anim.opacity = e;
        anim.scale = 0.2 + e * 0.8;
        anim.cx = anim.tx;
        anim.cy = anim.ty;
        if (t >= 1) {
          if (anim.closing) {
            anim.opacity = 0;
            anim.scale = 0.2;
          } else {
            animatingNodesRef.current.delete(id);
          }
        } else {
          stillGoing = true;
        }
      }
      for (const [id, link] of animatingLinksRef.current) {
        const elapsed = now - link.born;
        const t = Math.min(1, elapsed / LINK_DURATION);
        link.progress = link.closing ? 1 - LINK_EASING(t) : LINK_EASING(t);
        if (t >= 1) {
          if (link.closing) {
            link.progress = 0;
          } else {
            animatingLinksRef.current.delete(id);
          }
        } else {
          stillGoing = true;
        }
      }
      drawRef.current();
      if (stillGoing) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        stopAnim();
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [stopAnim]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (canvas.width < 10 || canvas.height < 10) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { x, y, k } = transformRef.current;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";

    const isFiltering = filter.trim().length > 0;
    let matchSet: Set<string>;
    if (isFiltering) {
      if (lastFilterRef.current !== filter) {
        const fullH = computeLayout();
        if (fullH) matchSetCacheRef.current = computeMatchSet(fullH, filter);
        lastFilterRef.current = filter;
      }
      matchSet = matchSetCacheRef.current;
    } else {
      matchSet = new Set<string>();
    }

    const hierarchy = isFiltering ? computeLayout(matchSet) : computeLayout();
    if (!hierarchy) return;

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);

    const cW = canvas.width / dpr;
    const cH = canvas.height / dpr;
    const vxMin = -x / k - 150,
      vxMax = (cW - x) / k + 150;
    const vyMin = -y / k - 150,
      vyMax = (cH - y) / k + 150;

    for (const link of hierarchy.links()) {
      const sx = Math.round(link.source.x ?? 0),
        sy = Math.round(link.source.y ?? 0);
      const tx = Math.round(link.target.x ?? 0),
        ty = Math.round(link.target.y ?? 0);
      const midY = Math.round(sy + (ty - sy) * 0.5);
      const isMatch = !isFiltering || matchSet.has(link.target.data.id);
      const linkAnim = animatingLinksRef.current.get(link.target.data.id);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.bezierCurveTo(sx, midY, tx, midY, tx, ty);
      ctx.strokeStyle =
        link.target.data.type === "folder"
          ? "rgba(148,163,184,0.18)"
          : "rgba(100,116,139,0.12)";
      ctx.lineWidth = link.target.data.type === "folder" ? 1.0 : 0.7;
      ctx.globalAlpha = isFiltering ? (isMatch ? 1 : 0) : 1;
      ctx.lineCap = "round";

      if (linkAnim && linkAnim.progress < 1) {
        let len = 0,
          px = sx,
          py = sy;
        const N = 20;
        for (let i = 1; i <= N; i++) {
          const tt = i / N,
            it = 1 - tt;
          const nx =
            it * it * it * sx +
            3 * it * it * tt * sx +
            3 * it * tt * tt * tx +
            tt * tt * tt * tx;
          const ny =
            it * it * it * sy +
            3 * it * it * tt * midY +
            3 * it * tt * tt * midY +
            tt * tt * tt * ty;
          len += Math.hypot(nx - px, ny - py);
          px = nx;
          py = ny;
        }
        ctx.setLineDash([len]);
        ctx.lineDashOffset = len - len * linkAnim.progress;
      } else {
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }
      ctx.stroke();
      ctx.restore();
    }

    for (const node of hierarchy.descendants()) {
      const d = node.data;
      const anim = animatingNodesRef.current.get(d.id);
      const isMatch = !isFiltering || matchSet.has(d.id);
      const dimAlpha = isFiltering && !isMatch ? 0 : 1;
      const rawX = node.x ?? 0,
        rawY = node.y ?? 0;
      if (
        !anim &&
        (rawX < vxMin || rawX > vxMax || rawY < vyMin || rawY > vyMax)
      )
        continue;

      const nx = rawX;
      let ny = rawY,
        nodeOpacity = dimAlpha,
        nodeScale = 1;
      if (anim) {
        nodeOpacity = Math.min(dimAlpha, anim.opacity);
        nodeScale = anim.scale;
        ny = anim.cy;
      }

      const r = nodeRadius(d);
      const key = iconKey(d);

      ctx.save();
      ctx.globalAlpha = nodeOpacity;
      if (nodeScale < 1) {
        ctx.translate(nx, ny);
        ctx.scale(nodeScale, nodeScale);
        ctx.translate(-nx, -ny);
      }

      if (d.type === "root") {
        const grd = ctx.createRadialGradient(nx, ny, 0, nx, ny, r * 2.5);
        grd.addColorStop(0, "rgba(96,165,250,0.07)");
        grd.addColorStop(1, "rgba(96,165,250,0)");
        ctx.beginPath();
        ctx.arc(nx, ny, r * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(nx, ny, r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(12,18,36,0.92)";
        ctx.fill();
        ctx.strokeStyle = "rgba(147,197,253,0.55)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        const tinted = getTinted(key, "#93c5fd");
        if (tinted)
          ctx.drawImage(tinted, nx - r * 0.6, ny - r * 0.6, r * 1.2, r * 1.2);
        ctx.fillStyle = "#bfdbfe";
        ctx.font = "bold 9px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(
          d.name.length > 18 ? d.name.slice(0, 17) + "\u2026" : d.name,
          nx,
          ny + r + 5,
        );
      } else if (d.type === "folder") {
        const isCollapsed = d.originalChildren.length > 0 && !d.children;
        const accent = isCollapsed ? "#e2e8f0" : "#94a3b8";
        ctx.beginPath();
        ctx.arc(nx, ny, r, 0, Math.PI * 2);
        ctx.fillStyle = isCollapsed
          ? "rgba(28,38,56,0.88)"
          : "rgba(15,22,36,0.78)";
        ctx.fill();
        ctx.strokeStyle = isCollapsed
          ? "rgba(226,232,240,0.4)"
          : "rgba(148,163,184,0.2)";
        ctx.lineWidth = isCollapsed ? 1.5 : 0.9;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(nx, ny, r * 0.7, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(accent, 0.07);
        ctx.fill();
        const tinted = getTinted(key, accent);
        if (tinted)
          ctx.drawImage(
            tinted,
            nx - r * 0.58,
            ny - r * 0.58,
            r * 1.16,
            r * 1.16,
          );
        ctx.fillStyle = isCollapsed ? "#e2e8f0" : "#94a3b8";
        ctx.font = `${isCollapsed ? "bold " : ""}8px monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(
          d.name.length > 12 ? d.name.slice(0, 11) + "\u2026" : d.name,
          nx,
          ny + r + 4,
        );
        if (isCollapsed && d.originalChildren.length > 0) {
          const label = `+${d.originalChildren.length}`,
            bw = label.length * 6 + 10;
          ctx.fillStyle = "rgba(203,213,225,0.08)";
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
        ctx.fillStyle = "rgba(12,18,32,0.82)";
        ctx.fill();
        ctx.strokeStyle = hexToRgba(color, 0.5);
        ctx.lineWidth = 0.8;
        ctx.stroke();
        if (isLargeZoom) {
          ctx.beginPath();
          ctx.arc(nx, ny, radius * 0.72, 0, Math.PI * 2);
          ctx.fillStyle = hexToRgba(color, 0.1);
          ctx.fill();
          const tinted = getTinted(key, color);
          if (tinted) {
            const is = radius * 1.1;
            ctx.drawImage(tinted, nx - is / 2, ny - is / 2, is, is);
          }
        } else {
          ctx.beginPath();
          ctx.arc(nx, ny, radius * 0.55, 0, Math.PI * 2);
          ctx.fillStyle = hexToRgba(color, 0.82);
          ctx.fill();
        }
        if (k > 0.9) {
          ctx.fillStyle = hexToRgba(color, 0.82);
          ctx.font = "7px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(
            d.name.length > 16 ? d.name.slice(0, 15) + "\u2026" : d.name,
            nx,
            ny + radius + 4,
          );
        }
      }
      ctx.restore();
    }
    ctx.restore();
  }, [computeLayout, getTinted, filter]);

  useEffect(() => {
    drawRef.current = draw;
  }, [draw]);
  useEffect(() => {
    draw();
  }, [iconsReady, draw]);

  useEffect(() => {
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      drawRef.current();
      id = setTimeout(tick, 50);
    };
    id = setTimeout(tick, 50);
    return () => clearTimeout(id);
  }, []);

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

  const hitTest = useCallback(
    (ex: number, ey: number): TreeNode | null => {
      const isFiltering = filter.trim().length > 0;
      const matchSet = isFiltering
        ? matchSetCacheRef.current
        : new Set<string>();
      const h = isFiltering ? computeLayout(matchSet) : computeLayout();
      if (!h) return null;
      const { x, y, k } = transformRef.current;
      const mx = (ex - x) / k,
        my = (ey - y) / k;
      for (const node of h.descendants()) {
        const d = node.data;
        if (isFiltering && !matchSet.has(d.id)) continue;
        const threshold = d.type === "root" ? 28 : nodeRadius(d) + 8;
        if (Math.hypot((node.x ?? 0) - mx, (node.y ?? 0) - my) < threshold)
          return d;
      }
      return null;
    },
    [computeLayout, filter],
  );

  const toggleFolder = useCallback(
    (hit: TreeNode) => {
      const wasOpen = !!hit.children;
      const currentH = computeLayout();
      if (!currentH) return;
      const folderH = currentH.descendants().find((n) => n.data.id === hit.id);
      const parentX = folderH?.x ?? 0,
        parentY = folderH?.y ?? 0;

      if (!wasOpen && hit.originalChildren.length > 0) {
        hit.children = hit.originalChildren;
        layoutCacheRef.current = null;
        filteredLayoutCacheRef.current = null;
        const newH = computeLayout();
        if (!newH) return;
        const now = performance.now();
        newH.descendants().forEach((n) => {
          if (n.data.id === hit.id) return;
          if (!folderH || n.depth <= folderH.depth) return;
          let anc = n.parent,
            isChild = false;
          while (anc) {
            if (anc.data.id === hit.id) {
              isChild = true;
              break;
            }
            anc = anc.parent;
          }
          if (!isChild) return;
          const d = n.data;
          animatingNodesRef.current.set(d.id, {
            id: d.id,
            cx: parentX,
            cy: parentY,
            tx: n.x ?? 0,
            ty: n.y ?? 0,
            opacity: 0,
            scale: 0,
            born: now,
            closing: false,
          });
          animatingLinksRef.current.set(d.id, {
            childId: d.id,
            progress: 0,
            born: now,
            closing: false,
          });
        });
        startAnimLoop();
      } else if (wasOpen) {
        const now = performance.now();
        currentH.descendants().forEach((n) => {
          if (n.data.id === hit.id) return;
          let anc = n.parent,
            isChild = false;
          while (anc) {
            if (anc.data.id === hit.id) {
              isChild = true;
              break;
            }
            anc = anc.parent;
          }
          if (!isChild) return;
          const d = n.data;
          const existingNode = animatingNodesRef.current.get(d.id);
          const existingLink = animatingLinksRef.current.get(d.id);
          const nodeProg = existingNode ? existingNode.opacity : 1;
          const linkProg = existingLink ? existingLink.progress : 1;
          animatingNodesRef.current.set(d.id, {
            id: d.id,
            cx: n.x ?? 0,
            cy: n.y ?? 0,
            tx: n.x ?? 0,
            ty: n.y ?? 0,
            opacity: nodeProg,
            scale: 0.2 + nodeProg * 0.8,
            born: now - ANIM_DURATION * (1 - nodeProg),
            closing: true,
          });
          animatingLinksRef.current.set(d.id, {
            childId: d.id,
            progress: linkProg,
            born: now - LINK_DURATION * (1 - linkProg),
            closing: true,
          });
        });
        const descendantIds = new Set<string>();
        currentH.descendants().forEach((n) => {
          if (n.data.id === hit.id) return;
          let anc = n.parent;
          while (anc) {
            if (anc.data.id === hit.id) {
              descendantIds.add(n.data.id);
              break;
            }
            anc = anc.parent;
          }
        });
        startAnimLoop();
        setTimeout(() => {
          for (const id of descendantIds) {
            animatingNodesRef.current.delete(id);
            animatingLinksRef.current.delete(id);
          }
          hit.children = null;
          layoutCacheRef.current = null;
          filteredLayoutCacheRef.current = null;
          forceRender((n) => n + 1);
        }, ANIM_DURATION);
      }
      drawRef.current();
      forceRender((n) => n + 1);
    },
    [computeLayout, startAnimLoop],
  );

  // Fetch file content from server cache
  const fetchFileContent = useCallback(
    async (filePath: string): Promise<any> => {
      const repoFullName =
        useSelectionStore.getState().selection.repoContext?.meta.fullName;
      if (!repoFullName) return { content: "", error: "No repo context" };
      try {
        const res = await fetch(
          `/api/file-content?repo=${encodeURIComponent(repoFullName)}&path=${encodeURIComponent(filePath)}`,
        );
        if (!res.ok) {
          const text = await res.text();
          return { content: "", error: text };
        }
        return await res.json();
      } catch (err) {
        return { content: "", error: "Fetch failed" };
      }
    },
    [],
  );

  const onClick = useCallback(
    async (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current!.getBoundingClientRect();
      const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (!hit) return;

      if (hit.type === "folder") {
        toggleFolder(hit);
        setSelection(
          "folder",
          hit.name,
          hit.id,
          (hit.fileDetails as any) ?? null,
        );
      } else if (hit.type === "file") {
        const filesMetadata = useSelectionStore.getState().filesMetadata ?? [];
        const richFile = filesMetadata.find((f: any) => f.path === hit.id);
        setSelection(
          "file",
          hit.name,
          hit.id,
          richFile ?? (hit.fileDetails as any) ?? null,
        );

        // Open panel immediately in loading state
        setActiveFile({
          node: hit,
          content: "",
          loading: true,
          imageDataUrl: undefined,
          history: null,
        });

        // Fetch content from server cache
        const data = await fetchFileContent(hit.id);
        if (data && !data.error) {
          setFileContext({
            ...richFile,
            ...data,
            name: hit.name,
            path: hit.id,
          });
        }
        setActiveFile((prev) =>
          prev?.node.id === hit.id
            ? {
                ...prev,
                content: data.content ?? "",
                loading: false,
                error: data.error,
              }
            : prev,
        );
      } else if (hit.type === "root") {
        const existing = useSelectionStore.getState().selection.repoContext;
        if (existing) {
          useSelectionStore.getState().setRepoContext(existing);
        } else {
          setSelection("repo", data.details?.name ?? "Root", "/", null);
        }
      }
    },
    [hitTest, toggleFolder, data, setSelection, fetchFileContent],
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
          hit?.type === "folder" || hit?.type === "file" || hit?.type === "root"
            ? "pointer"
            : "default";
    },
    [hitTest],
  );

  const renderTooltipContent = (node: TreeNode) => {
    if (node.type === "root") {
      const rc = storeRepoContext;
      return (
        <div className="min-w-[250px] max-w-[280px] p-0.5">
          <div className="flex items-center gap-2 mb-2">
            {(rc?.meta.avatar || node.details?.avatar) && (
              <img
                src={rc?.meta.avatar ?? node.details?.avatar}
                className="w-8 h-8 rounded border border-gray-700 shrink-0"
                alt="avatar"
              />
            )}
            <div className="min-w-0">
              <div className="text-[12px] text-gray-100 font-bold truncate leading-tight">
                {rc?.meta.fullName ?? node.name}
              </div>
              <div className="text-[9px] text-blue-500/80 truncate font-mono mt-0.5">
                {rc?.github?.description?.slice(0, 60) ??
                  `@${node.details?.owner}`}
                ...
              </div>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-1 mb-2">
            {[
              {
                l: "Stars",
                v: rc?.meta.stars ?? node.details?.stars ?? 0,
                c: "#fbbf24",
              },
              {
                l: "Forks",
                v: rc?.meta.forks ?? node.details?.forks ?? 0,
                c: "#60a5fa",
              },
              {
                l: "Issues",
                v: rc?.meta.openIssues ?? node.details?.openIssues ?? 0,
                c: "#f87171",
              },
              {
                l: "Files",
                v: rc ? `${rc.stats.totalFiles}` : null,
                c: "#94a3b8",
              },
            ].map((s) => (
              <div
                key={s.l}
                className="bg-white/5 rounded px-1 py-1 text-center border border-white/5"
              >
                <div className="font-bold text-[9px]">
                  {typeof s.v === "number" && s.v > 999
                    ? `${(s.v / 1000).toFixed(1)}k`
                    : s.v}
                </div>
                <div className="text-[7px] text-gray-500 uppercase leading-none">
                  {s.l}
                </div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-white/5 pt-2">
            {[
              { k: "Lang", v: rc?.meta.language || "Mixed", c: "#fb923c" },
              { k: "Arch", v: rc?.stack.architecture, c: "#a78bfa" },

              { k: "Items", v: rc?.stats.rootItemCount, c: "#34d399" },
              { k: "License", v: rc?.meta.license || "None", c: "#86efac" },
            ].map(
              (r) =>
                r.v && (
                  <div
                    key={r.k}
                    className="flex justify-between text-[9px] min-w-0"
                  >
                    <span className="text-gray-600 mr-2">{r.k}</span>
                    <span
                      className="font-mono truncate text-right"
                      style={{ color: r.c }}
                    >
                      {r.v}
                    </span>
                  </div>
                ),
            )}
            <div className="flex justify-between text-[9px] col-span-2 border-t border-white/5 pt-2">
              <span className="text-gray-600">Updated</span>
              <span className="font-mono text-gray-400">
                {rc?.meta.pushedAt
                  ? new Date(rc.meta.pushedAt).toLocaleDateString()
                  : "—"}
              </span>
            </div>
          </div>
          {rc?.stack && (
            <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-white/5">
              {hasData
                .filter(({ key }) => rc.stack[key as keyof typeof rc.stack])
                .map(({ label, color }) => (
                  <Badge key={label} color={color}>
                    {label}
                  </Badge>
                ))}
            </div>
          )}
          {rc?.latestCommit && (
            <div className="mt-2 pt-1.5 border-t border-white/5 flex items-center gap-2">
              <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm bg-gray-900/50 border border-gray-800 text-gray-500 shrink-0">
                {rc.latestCommit.shortSha}
              </span>
              <span className="text-[9px] text-gray-500 truncate">
                {rc.latestCommit.message}
              </span>
            </div>
          )}
        </div>
      );
    }

    if (node.type === "folder") {
      const fc = storeFolderContext?.id === node.id ? storeFolderContext : null;
      return (
        <div className="min-w-[220px] max-w-[280px] space-y-2.5">
          <div>
            <div className="text-[12px] text-gray-100 font-bold">
              {node.name}/
            </div>
            <div className="text-[9px] text-blue-500/60 truncate font-mono">
              {node.fileDetails?.path}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {[
              {
                label: "Children",
                value: node.originalChildren.length,
                color: "#60a5fa",
              },
              {
                label: "Depth",
                value: `L${node.fileDetails?.depth}`,
                color: "#94a3b8",
              },
              {
                label: "Size",
                value:
                  node.size > 1048576
                    ? `${(node.size / 1048576).toFixed(1)}MB`
                    : `${(node.size / 1024).toFixed(0)}KB`,
                color: "#fb923c",
              },
              {
                label: "Subtree",
                value: fc
                  ? `${fc.stats.totalFiles}f ${fc.stats.totalFolders}d`
                  : `${node.fileDetails?.branchWeight ?? "—"}`,
                color: "#34d399",
              },
            ].map((s) => (
              <div
                key={s.label}
                className="bg-gray-800/50 rounded-lg px-2 py-1.5 border border-gray-700"
              >
                <div className="text-[8px] text-gray-500 uppercase tracking-tight mb-0.5">
                  {s.label}
                </div>
                <div
                  className="text-[11px] font-mono font-bold"
                  style={{ color: s.color }}
                >
                  {s.value}
                </div>
              </div>
            ))}
          </div>
          {fc && (
            <>
              <div className="flex flex-wrap gap-1">
                {fc.flags.isEntryPoint && <Badge color="#34d399">Entry</Badge>}
                {fc.flags.isConfigFolder && (
                  <Badge color="#fbbf24">Config</Badge>
                )}
                {fc.flags.hasReadme && <Badge color="#94a3b8">README</Badge>}
              </div>
              {fc.lastCommit && (
                <div className="border-t border-gray-700 pt-2">
                  <div className="text-[8px] text-gray-500 uppercase tracking-wider mb-1">
                    Last Commit
                  </div>
                  <div className="flex items-center gap-1.5">
                    {fc.lastCommit.avatarUrl && (
                      <img
                        src={fc.lastCommit.avatarUrl}
                        className="w-4 h-4 rounded-full border border-gray-700"
                        alt=""
                      />
                    )}
                    <div className="min-w-0">
                      <div className="text-[9px] text-gray-300 truncate">
                        {fc.lastCommit.message.split("\n")[0].slice(0, 35)}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      );
    }

    const fctx = storeFileContext?.id === node.id ? storeFileContext : null;
    const { color } = fileColor(node.ext);
    return (
      <div className="min-w-[220px] max-w-[280px] space-y-2.5">
        <div className="flex items-center gap-2">
          <div
            className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
            style={{
              background: hexToRgba(color, 0.1),
              border: `1px solid ${hexToRgba(color, 0.2)}`,
            }}
          >
            <FileCode2 size={12} style={{ color }} />
          </div>
          <div className="min-w-0">
            <div className="text-[12px] text-gray-100 font-bold truncate">
              {node.name}
            </div>
            <div
              className="text-[9px] font-mono truncate"
              style={{ color: hexToRgba(color, 0.6) }}
            >
              .{node.ext}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="bg-gray-800/50 rounded-lg px-2 py-1.5 border border-gray-700">
            <div className="text-[8px] text-gray-500 uppercase tracking-tight mb-0.5">
              Size
            </div>
            <div
              className="text-[11px] font-mono font-bold"
              style={{
                color: node.fileDetails?.isLarge ? "#fb923c" : "#94a3b8",
              }}
            >
              {node.size > 1048576
                ? `${(node.size / 1048576).toFixed(1)}MB`
                : `${(node.size / 1024).toFixed(1)}KB`}
            </div>
          </div>
          <div className="bg-gray-800/50 rounded-lg px-2 py-1.5 border border-gray-700">
            <div className="text-[8px] text-gray-500 uppercase tracking-tight mb-0.5">
              Depth
            </div>
            <div className="text-[11px] font-mono font-bold text-gray-400">
              L{node.fileDetails?.depth}
            </div>
          </div>
        </div>
        {fctx?.metrics && (
          <div className="grid grid-cols-3 gap-1">
            {[
              { v: fctx.metrics.lineCount, l: "Lines", c: "#94a3b8" },
              { v: fctx.analysis.functionCount, l: "Funcs", c: "#818cf8" },
              { v: fctx.analysis.classCount, l: "Class", c: "#a78bfa" },
            ].map((s) => (
              <div
                key={s.l}
                className="bg-gray-800/50 rounded-lg py-1 border border-gray-700 text-center"
              >
                <div
                  className="text-[10px] font-mono font-bold"
                  style={{ color: s.c }}
                >
                  {s.v}
                </div>
                <div className="text-[7px] text-gray-600 uppercase">{s.l}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const sidebarWidth = legendOpen ? 180 : 48;
  const fc = activeFile ? fileColor(activeFile.node.ext) : null;

  return (
    <div
      ref={rootRef}
      className="relative w-full h-full overflow-hidden bg-gray-900"
    >
      <div
        ref={treeContainerRef}
        className="absolute left-0 right-0 top-0 overflow-hidden"
        style={{ bottom: activeFile ? `calc(100% - ${topPx ?? 0}px)` : 0 }}
      >
        <div
          className="absolute right-0 border-l border-gray-700 top-0 bg-gray-900 bottom-0 z-10 flex flex-col transition-all duration-200 overflow-hidden"
          style={{ width: sidebarWidth }}
        >
          <div
            className={`shrink-0 p-1.5 flex border-b border-gray-700 items-center ${legendOpen ? "justify-between" : "justify-center"}`}
          >
            {legendOpen && (
              <div className="flex items-center gap-1.5 pl-1">
                <GitBranch size={10} className="text-slate-600" />
                <span className="text-[9px] font-mono font-bold text-slate-600 uppercase tracking-widest pt-0.5">
                  File Types
                </span>
              </div>
            )}
            <button
              onClick={() => setLegendOpen((v) => !v)}
              className="w-6 h-6 cursor-pointer flex items-center justify-center rounded-md transition-colors text-slate-600 hover:text-slate-300 hover:bg-white/5"
            >
              <ChevronLeft
                size={12}
                className={`transition-transform text-gray-500 duration-200 ${legendOpen ? "rotate-180" : ""}`}
              />
            </button>
          </div>
          {legendOpen && (
            <div className="flex-1 overflow-y-auto px-1.5 py-1.5 flex flex-col gap-0.5">
              {presentGroups.map(({ label, color, exts, icon: Icon }) => {
                const isExpanded = expandedGroups.has(label);
                const toggleExpand = () =>
                  setExpandedGroups((prev) => {
                    const next = new Set(prev);
                    if (next.has(label)) next.delete(label);
                    else next.add(label);
                    return next;
                  });
                return (
                  <div
                    key={label}
                    className="flex flex-col rounded-md overflow-hidden"
                  >
                    <div
                      className="flex items-center gap-2 px-1.5 py-1 hover:bg-white/4 transition-colors cursor-pointer"
                      onClick={toggleExpand}
                    >
                      <div
                        className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center"
                        style={{ background: hexToRgba(color, 0.15) }}
                      >
                        <Icon size={10} style={{ color }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div
                          className="text-[11px] font-semibold leading-tight"
                          style={{ color }}
                        >
                          {label}
                        </div>
                        <div
                          className="text-[9px] leading-tight truncate mt-0.5 font-mono transition-all duration-200 overflow-hidden"
                          style={{
                            color: hexToRgba(color, 0.6),
                            maxHeight: isExpanded ? "0px" : "18px",
                            opacity: isExpanded ? 0 : 1,
                          }}
                        >
                          {exts.length > 0
                            ? exts
                                .slice(0, 4)
                                .map((e) => `.${e}`)
                                .join(" ") + (exts.length > 4 ? " \u2026" : "")
                            : "others"}
                        </div>
                      </div>
                      <ChevronDown
                        size={10}
                        className="shrink-0 transition-transform duration-200"
                        style={{
                          color: hexToRgba(color, 0.5),
                          transform: isExpanded
                            ? "rotate(180deg)"
                            : "rotate(0deg)",
                        }}
                      />
                    </div>
                    <div
                      className="flex flex-wrap gap-1 px-2.5 overflow-hidden transition-all duration-200"
                      style={{
                        background: hexToRgba(color, 0.04),
                        maxHeight: isExpanded ? "200px" : "0px",
                        paddingTop: isExpanded ? "3px" : "0px",
                        paddingBottom: isExpanded ? "6px" : "0px",
                        opacity: isExpanded ? 1 : 0,
                      }}
                    >
                      {exts.length > 0 ? (
                        exts.map((e) => (
                          <span
                            key={e}
                            className="text-[9px] font-mono px-1 py-0 rounded-sm"
                            style={{
                              color: hexToRgba(color, 0.85),
                              background: hexToRgba(color, 0.1),
                            }}
                          >
                            .{e}
                          </span>
                        ))
                      ) : (
                        <span
                          className="text-[9px] font-mono"
                          style={{ color: hexToRgba(color, 0.4) }}
                        >
                          others
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

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

        {tooltip && (
          <div
            className="absolute z-20 pointer-events-none px-3 py-2.5 rounded-xl font-mono shadow-2xl"
            style={{
              left: tooltip.x + 15,
              top: Math.min(
                tooltip.y - 8,
                (treeContainerRef.current?.clientHeight ?? 400) - 300,
              ),
              background: "#0f172a",
              border: "1px solid #334155",
              borderRadius: "12px",
              boxShadow: "0 20px 50px rgba(0,0,0,0.5)",
            }}
          >
            {renderTooltipContent(tooltip.node)}
          </div>
        )}
      </div>

      {activeFile && topPx !== null && (
        <div
          className="absolute left-0 right-0 z-30 flex items-center justify-center group"
          style={{ top: topPx, height: 4, cursor: "row-resize" }}
          onMouseDown={onDragStart}
        >
          <div
            className="absolute inset-0 transition-colors"
            style={{ background: "rgba(30,41,59,0.4)" }}
          />
          <div
            className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ background: "rgba(59,130,246,0.2)" }}
          />
          <div
            className="relative z-10 flex items-center gap-1 px-2 py-0.5 rounded-full pointer-events-none"
            style={{
              background: "rgba(10,16,28,0.95)",
              border: "1px solid rgba(51,65,85,0.8)",
            }}
          >
            <GripHorizontal
              size={9}
              className="text-slate-600 group-hover:text-blue-400 transition-colors"
            />
          </div>
        </div>
      )}

      {activeFile && topPx !== null && (
        <div
          className="absolute left-0 right-0 bottom-0 flex flex-col overflow-hidden"
          style={{
            top: topPx + 6,
            background: "linear-gradient(180deg, #060b14 0%, #060810 100%)",
          }}
        >
          {/* Header */}
          <div
            className="shrink-0 flex items-center gap-2.5 px-3 py-2"
            style={{
              background: fc
                ? hexToRgba(fc.color, 0.03)
                : "rgba(10,15,26,0.85)",
              borderBottom: `1px solid ${fc ? hexToRgba(fc.color, 0.08) : "rgba(30,41,59,0.5)"}`,
            }}
          >
            <div
              className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center"
              style={{
                background: fc
                  ? hexToRgba(fc.color, 0.08)
                  : "rgba(30,41,59,0.4)",
                border: `1px solid ${fc ? hexToRgba(fc.color, 0.15) : "rgba(51,65,85,0.4)"}`,
              }}
            >
              {fc && <fc.icon size={12} style={{ color: fc.color }} />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-bold text-white font-mono truncate leading-none">
                {activeFile.node.name}
              </div>
              <div className="text-[9px] text-slate-500 font-mono truncate mt-0.5">
                {activeFile.node.fileDetails?.path}
              </div>
            </div>
            <div className="hidden sm:flex items-center gap-1 shrink-0">
              {storeFileContext?.metrics && (
                <>
                  <Badge color="#64748b">
                    {storeFileContext.metrics.lineCount}L
                  </Badge>
                  <Badge color="#818cf8">
                    {storeFileContext.analysis.functionCount}ƒ
                  </Badge>
                  {storeFileContext.analysis.isTypeScript && (
                    <Badge color="#3b82f6">TS</Badge>
                  )}
                  {storeFileContext.analysis.isReact && (
                    <Badge color="#61dafb">React</Badge>
                  )}
                </>
              )}
              <Badge color="#475569">
                {(activeFile.node.size / 1024).toFixed(1)} KB
              </Badge>
            </div>
            <button
              onClick={() => setActiveFile(null)}
              className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md transition-all border border-slate-800 text-slate-600 hover:text-red-400 hover:bg-red-400/10 hover:border-red-400/20"
            >
              <X size={12} />
            </button>
          </div>

          <div className="flex flex-1 min-h-0">
            {/* Source pane */}
            <div
              className="flex flex-col border-r overflow-hidden"
              style={{ width: "58%", borderColor: "rgba(30,41,59,0.5)" }}
            >
              <div
                className="shrink-0 flex items-center gap-2 px-3 py-1.5"
                style={{
                  borderBottom: "1px solid rgba(30,41,59,0.4)",
                  background: "rgba(4,7,14,0.7)",
                }}
              >
                <Code2 size={10} className="text-slate-600" />
                <span className="text-[9px] font-mono font-bold text-slate-600 uppercase tracking-widest">
                  {activeFile.imageDataUrl ? "Preview" : "Source"}
                </span>
                {storeFileContext?.metrics && (
                  <span className="ml-auto text-[9px] font-mono text-slate-600">
                    {storeFileContext.metrics.codeLines}c ·{" "}
                    {storeFileContext.metrics.commentLines}
                    {" // · "}
                    {storeFileContext.metrics.emptyLines}Ø
                  </span>
                )}
              </div>
              <div className="flex-1 overflow-auto bg-[#020408]">
                {activeFile.loading ? (
                  <div className="flex items-center justify-center w-full h-full gap-2 text-slate-600">
                    <Loader2 size={14} className="animate-spin" />
                    <span className="text-[10px] font-mono">Loading…</span>
                  </div>
                ) : activeFile.error && !activeFile.content ? (
                  <div className="flex items-center justify-center w-full h-full">
                    <span className="text-[10px] font-mono text-red-500/60">
                      {activeFile.error}
                    </span>
                  </div>
                ) : activeFile.imageDataUrl ? (
                  <div className="flex items-center justify-center w-full h-full min-h-[180px] p-4">
                    <img
                      src={activeFile.imageDataUrl}
                      alt={activeFile.node.name}
                      className="max-w-full max-h-full object-contain rounded-lg shadow-xl"
                    />
                  </div>
                ) : (
                  <SyntaxHighlighter
                    language={activeFile.node.ext || "javascript"}
                    style={vscDarkPlus}
                    customStyle={{
                      margin: 0,
                      padding: "16px",
                      fontSize: "12px",
                      background: "transparent",
                      lineHeight: "1.5",
                    }}
                    showLineNumbers={true}
                    lineNumberStyle={{
                      minWidth: "2.5em",
                      paddingRight: "1em",
                      color: "#1e293b",
                      textAlign: "right",
                      userSelect: "none",
                    }}
                  >
                    {activeFile.content}
                  </SyntaxHighlighter>
                )}
              </div>
            </div>

            {/* Metadata pane */}
            <div
              className="flex flex-col overflow-auto custom-scrollbar shadow-[inset_1px_0_0_rgba(255,255,255,0.05)]"
              style={{ width: "42%", background: "#04070e" }}
            >
              {storeFileContext ? (
                <div className="p-5 space-y-7">
                  {/* Latest Activity Summary */}
                  {storeFileContext.latestCommit && (
                    <div className="relative group">
                      <div className="absolute -inset-0.5 bg-linear-to-r from-blue-500/20 to-purple-500/20 rounded-xl blur opacity-30 group-hover:opacity-50 transition duration-500" />
                      <div className="relative p-3 rounded-xl border border-white/5 bg-gray-950/40 backdrop-blur-md">
                        <div className="flex items-center gap-2 mb-2.5">
                          <div className="p-1 rounded bg-blue-500/10 border border-blue-500/20">
                            <History size={10} className="text-blue-400" />
                          </div>
                          <span className="text-[9px] font-mono font-bold text-slate-500 uppercase tracking-widest">
                            Latest Update
                          </span>
                          <span className="ml-auto text-[8px] font-mono text-slate-600 bg-white/5 px-1.5 py-0.5 rounded border border-white/5">
                            {storeFileContext.latestCommit.shortSha}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {storeFileContext.latestCommit.avatarUrl ? (
                            <img
                              src={storeFileContext.latestCommit.avatarUrl}
                              className="w-6 h-6 rounded-full border border-white/10 ring-2 ring-white/5"
                              alt=""
                            />
                          ) : (
                            <div className="w-6 h-6 rounded-full bg-slate-800 flex items-center justify-center">
                              <User size={10} className="text-slate-500" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="text-[11px] text-slate-300 font-medium truncate leading-normal">
                              {storeFileContext.latestCommit.message}
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span className="text-[9px] text-blue-400/80 font-semibold">
                                {storeFileContext.latestCommit.author}
                              </span>
                              <span className="text-[8px] text-slate-600 flex items-center gap-1">
                                <Clock size={8} />
                                {new Date(
                                  storeFileContext.latestCommit.date,
                                ).toLocaleDateString()}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Core Metrics */}
                  <section>
                    <div className="flex items-center gap-1.5 mb-3 px-1">
                      <BarChart2 size={11} className="text-slate-400" />
                      <h3 className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-[0.2em]">
                        Code Metrics
                      </h3>
                    </div>
                    {storeFileContext.metrics ? (
                      <div className="grid grid-cols-3 gap-1.5">
                        <StatPill
                          icon={FileText}
                          label="Lines"
                          value={storeFileContext.metrics.lineCount.toLocaleString()}
                          accent="#94a3b8"
                        />
                        <StatPill
                          icon={Code2}
                          label="Logic"
                          value={storeFileContext.metrics.codeLines.toLocaleString()}
                          accent="#60a5fa"
                        />
                        <StatPill
                          icon={Hash}
                          label="Empty"
                          value={storeFileContext.metrics.emptyLines}
                          accent="#475569"
                        />
                        <StatPill
                          icon={Cpu}
                          label="Funcs"
                          value={storeFileContext.analysis?.functionCount ?? 0}
                          accent="#818cf8"
                        />
                        <StatPill
                          icon={Box}
                          label="Classes"
                          value={storeFileContext.analysis?.classCount ?? 0}
                          accent="#a78bfa"
                        />
                        <StatPill
                          icon={Zap}
                          label="Exports"
                          value={
                            storeFileContext.analysis?.exports?.length ?? 0
                          }
                          accent="#34d399"
                        />
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-1.5">
                        <StatPill
                          icon={HardDrive}
                          label="Size"
                          value={`${(storeFileContext.size / 1024).toFixed(1)} KB`}
                          accent="#60a5fa"
                        />
                        <StatPill
                          icon={Hash}
                          label="Depth"
                          value={`Level ${storeFileContext.depth}`}
                          accent="#64748b"
                        />
                      </div>
                    )}
                  </section>

                  {/* Analysis Breakdown */}
                  {storeFileContext.analysis && (
                    <section>
                      <div className="flex items-center gap-1.5 mb-3 px-1">
                        <Terminal size={11} className="text-slate-400" />
                        <h3 className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-[0.2em]">
                          Deep Analysis
                        </h3>
                      </div>
                      <div className="rounded-xl border border-white/5 bg-white/2 p-3 space-y-3">
                        <div className="space-y-2">
                          {[
                            {
                              label: "Component Logic",
                              value: storeFileContext.analysis.logicType,
                              color: "#60a5fa",
                            },
                            {
                              label: "Resolved Imports",
                              value:
                                storeFileContext.resolvedImports?.length ?? 0,
                              color: "#94a3b8",
                            },
                            {
                              label: "Exposed Symbols",
                              value:
                                storeFileContext.analysis.exports?.length ?? 0,
                              color: "#a78bfa",
                            },
                            {
                              label: "Technical Debt",
                              value: `${storeFileContext.analysis.todoComments?.length ?? 0} TODOs`,
                              color:
                                (storeFileContext.analysis.todoComments
                                  ?.length ?? 0) > 0
                                  ? "#fbbf24"
                                  : "#334155",
                            },
                          ].map((item) => (
                            <div
                              key={item.label}
                              className="flex items-center justify-between text-[11px]"
                            >
                              <span className="text-slate-500 font-medium font-mono lowercase">
                                {item.label}
                              </span>
                              <div className="flex items-center gap-2">
                                <div className="h-0.5 w-12 bg-slate-800 rounded-full overflow-hidden">
                                  <div
                                    className="h-full rounded-full"
                                    style={{
                                      background: item.color,
                                      width:
                                        typeof item.value === "string"
                                          ? "100%"
                                          : `${Math.min(100, (Number(item.value) || 0) * 10)}%`,
                                      opacity: 0.3,
                                    }}
                                  />
                                </div>
                                <span
                                  className="font-bold font-mono"
                                  style={{ color: item.color }}
                                >
                                  {item.value}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {storeFileContext.analysis.isReact && (
                            <Badge color="#61dafb">React Component</Badge>
                          )}
                          {storeFileContext.analysis.isTypeScript && (
                            <Badge color="#3b82f6">TypeScript</Badge>
                          )}
                          {storeFileContext.analysis.hasJsx && (
                            <Badge color="#f472b6">JSX Enabled</Badge>
                          )}
                          {storeFileContext.analysis.isTest && (
                            <Badge color="#34d399">Test Script</Badge>
                          )}
                          {storeFileContext.analysis.isConfig && (
                            <Badge color="#fbbf24">Environment</Badge>
                          )}
                        </div>
                      </div>
                    </section>
                  )}

                  {/* Contributors */}
                  {storeFileContext.contributors &&
                    storeFileContext.contributors.length > 0 && (
                      <section>
                        <div className="flex items-center gap-1.5 mb-3 px-1">
                          <Users size={11} className="text-slate-400" />
                          <h3 className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-[0.2em]">
                            Contributors
                          </h3>
                        </div>
                        <div className="flex flex-col gap-2">
                          {storeFileContext.contributors
                            .slice(0, 5)
                            .map((u: any, ix: number) => {
                              const CardTag = u.profileUrl ? "a" : "div";
                              return (
                                <CardTag
                                  key={u.name || ix}
                                  {...(u.profileUrl
                                    ? {
                                        href: u.profileUrl,
                                        target: "_blank",
                                        rel: "noreferrer",
                                      }
                                    : {})}
                                  className="flex items-center gap-2.5 p-2 rounded-lg border border-white/5 bg-white/1 hover:bg-white/3 transition-colors group cursor-pointer"
                                >
                                  {u.avatarUrl ? (
                                    <img
                                      src={u.avatarUrl}
                                      className="w-7 h-7 rounded-lg border border-white/10"
                                      alt=""
                                    />
                                  ) : (
                                    <div className="w-7 h-7 rounded-lg bg-slate-800 flex items-center justify-center border border-white/5 text-slate-500">
                                      <User size={12} />
                                    </div>
                                  )}
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center justify-between">
                                      <span className="text-[11px] font-bold text-slate-300 group-hover:text-blue-400 truncate transition-colors">
                                        {u.name}
                                      </span>
                                      <span className="text-[10px] font-mono text-slate-500">
                                        {u.commits} commits
                                      </span>
                                    </div>
                                    <div className="h-1 w-full bg-slate-800 rounded-full mt-1.5 overflow-hidden">
                                      <div
                                        className="h-full bg-blue-500/40 rounded-full"
                                        style={{
                                          width: `${Math.min(100, (u.commits / (storeFileContext.contributors[0]?.commits || 1)) * 100)}%`,
                                        }}
                                      />
                                    </div>
                                  </div>
                                </CardTag>
                              );
                            })}
                        </div>
                      </section>
                    )}

                  {/* History Timeline */}
                  {storeFileContext.commits &&
                    storeFileContext.commits.length > 0 && (
                      <section>
                        <div className="flex items-center gap-1.5 mb-3 px-1">
                          <History size={11} className="text-slate-400" />
                          <h3 className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-[0.2em]">
                            Timeline
                          </h3>
                        </div>
                        <div className="relative space-y-4 before:absolute before:inset-0 before:left-[11px] before:w-px before:bg-white/4">
                          {storeFileContext.commits
                            .slice(0, 6)
                            .map((c: any, ix: number) => (
                              <div
                                key={c.sha || ix}
                                className="relative pl-7 group"
                              >
                                <div className="absolute left-[8px] top-1.5 w-1.5 h-1.5 rounded-full bg-slate-700 ring-4 ring-gray-950 z-10 group-hover:bg-blue-500 transition-colors" />
                                <div className="text-[11px] text-slate-400 group-hover:text-slate-200 transition-colors cursor-default">
                                  {c.message}
                                </div>
                                <div className="flex items-center gap-2 mt-1">
                                  <span className="text-[9px] font-bold text-blue-500/70 font-mono">
                                    {c.shortSha}
                                  </span>
                                  <span className="text-[8px] text-slate-600 font-mono">
                                    {new Date(c.date).toLocaleDateString()}
                                  </span>
                                </div>
                              </div>
                            ))}
                        </div>
                      </section>
                    )}

                  {/* Path & Technical Info */}
                  <section className="pt-2">
                    <div className="rounded-xl border border-dashed border-white/10 p-3 space-y-3 bg-black/20">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-slate-600 uppercase tracking-widest font-bold text-[9px]">
                            Repository Path
                          </span>
                          <button
                            onClick={() => navigator.clipboard.writeText(storeFileContext.path)}
                            className="text-slate-500 hover:text-blue-400 p-1 rounded hover:bg-white/5 transition-colors cursor-pointer"
                            title="Copy path"
                          >
                            <Copy size={9} />
                          </button>
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono break-all p-2 rounded-lg bg-white/2 border border-white/5 leading-relaxed">
                          {storeFileContext.path}
                        </div>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-slate-600 uppercase tracking-widest font-bold text-[9px]">
                          Object Metadata
                        </span>
                        <div className="flex items-center gap-1.5 p-1 rounded bg-white/2 border border-white/5">
                          <span className="text-[9px] font-bold text-slate-500 font-mono pl-1">
                            SHA: {activeFile.node.sha?.slice(0, 8)}
                          </span>
                          <button
                            onClick={() => navigator.clipboard.writeText(activeFile.node.sha ?? "")}
                            className="text-slate-600 hover:text-blue-400 p-1 rounded hover:bg-white/5 transition-colors cursor-pointer"
                            title="Copy SHA"
                          >
                            <Copy size={8} />
                          </button>
                        </div>
                      </div>

                      {storeRepoContext && (
                        <a
                          href={`${storeRepoContext.github?.htmlUrl}/blob/${storeRepoContext.meta?.defaultBranch}/${storeFileContext.path}`}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 transition-all group cursor-pointer mt-1"
                        >
                          <span className="text-[10px] font-bold text-slate-400 group-hover:text-blue-100 uppercase tracking-widest transition-colors">
                            View on GitHub
                          </span>
                          <ExternalLink size={10} className="text-slate-500 group-hover:text-blue-400 transition-colors" />
                        </a>
                      )}
                    </div>
                  </section>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center p-8 gap-4 opacity-30">
                  <div className="relative">
                    <FileCode2 size={40} className="text-slate-700" />
                    <div className="absolute -bottom-2 -right-2 p-1.5 rounded bg-blue-500/10 border border-blue-500/20">
                      <Loader2 size={12} className="text-blue-500 animate-spin" />
                    </div>
                  </div>
                  <div className="text-center">
                    <p className="text-[11px] font-mono text-slate-600 uppercase tracking-[0.2em] mb-1">
                      Hydrating Metadata
                    </p>
                    <p className="text-[9px] text-slate-800 font-mono">
                      Establishing connection to repository stream
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
