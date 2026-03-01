/**
 * almost completely ai made file sorry for who ever is seeing this file
 * idk whats happening here but probably shouldnt touch it
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
  ChevronDown,
  Calendar,
  FolderTree,
  Users,
  Zap,
  FileText,
  Terminal,
  Eye,
  Cpu,
  BarChart2,
  Box,
} from "lucide-react";
import { FileNode } from "@/modes/TreeMapper";
import { EXT_GROUPS, hasData, ICON_SVGS } from "@/constants/treeView.constants";
import { useSelectionStore } from "@/lib/store";
import { RepoTreeEntry } from "@/lib/types";
import Link from "next/link";

// ─── Repo tree helpers ────────────────────────────────────────────────────────

/** Recursively flattens a TreeNode tree into a list of RepoTreeEntry */
function flattenTree(nodes: TreeNode[], depth = 1): RepoTreeEntry[] {
  const result: RepoTreeEntry[] = [];
  for (const n of nodes) {
    result.push({
      path: n.fileDetails?.path ?? n.id,
      name: n.name,
      type: n.type === "folder" ? "folder" : "file",
      ext: n.ext,
      size: n.size,
      depth,
    });
    if (n.originalChildren.length > 0) {
      result.push(...flattenTree(n.originalChildren, depth + 1));
    }
  }
  return result;
}

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
    stars: number;
    forks: number;
    openIssues: number;
    size: number;
    pushedAt: string;
    language: string;
    license: string;
    defaultBranch: string;
    visibility: string;
  };
  fileDetails?: {
    depth: number;
    path: string;
    isLarge: boolean;
    branchWeight: number;
  };
  originalChildren: TreeNode[];
  children?: TreeNode[] | null;
}

interface AnimatingNode {
  id: string;
  cx: number;
  cy: number;
  tx: number;
  ty: number;
  opacity: number;
  scale: number;
  born: number;
  closing: boolean;
}

interface AnimatingLink {
  childId: string;
  progress: number;
  born: number;
  closing: boolean;
}

const ANIM_DURATION = 320;
const LINK_DURATION = 260;
const ANIM_EASING = (t: number) => 1 - Math.pow(1 - t, 3);
const LINK_EASING = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── UI helpers ───────────────────────────────────────────────────────────────

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
      className="flex flex-col gap-0.5 rounded-lg px-2 py-1.5 border"
      style={{
        background: hexToRgba(accent, 0.04),
        borderColor: hexToRgba(accent, 0.12),
      }}
    >
      <div className="flex items-center gap-1.5">
        <Icon size={9} style={{ color: accent }} />
        <span
          className="text-[8px] font-bold uppercase tracking-widest leading-none"
          style={{ color: hexToRgba(accent, 0.6) }}
        >
          {label}
        </span>
      </div>
      <div
        className="text-[11px] font-mono font-bold truncate leading-tight"
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
      className="text-[8px] font-mono px-1 py-0 rounded-md border"
      style={{
        color,
        background: hexToRgba(color, 0.08),
        borderColor: hexToRgba(color, 0.2),
      }}
    >
      {children}
    </span>
  );
}

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

  // ── Rich context slices from Zustand ─────────────────────────────────────
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

  // ── Draw ──────────────────────────────────────────────────────────────────
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

    // ── Links ──
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

    // ── Nodes ──
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

  const onClick = useCallback(
    async (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current!.getBoundingClientRect();
      const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (!hit) return;
      const owner = data.details?.owner;
      const repo = data.details?.name;
      if (!owner || !repo) return;
      const token = process.env.NEXT_PUBLIC_GITHUB_TOKEN;
      const headers = {
        Accept: "application/vnd.github.v3+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      if (hit.type === "folder") {
        toggleFolder(hit);
        try {
          const encodedPath = encodeURIComponent(hit.id);
          const [contentsRes, commitsRes] = await Promise.all([
            fetch(
              `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`,
              { headers },
            ),
            fetch(
              `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodedPath}&per_page=1`,
              { headers },
            ),
          ]);
          const folderContents: any[] = contentsRes.ok
            ? await contentsRes.json()
            : [];
          const commitsData: any[] = commitsRes.ok
            ? await commitsRes.json()
            : [];
          const lastCommit = commitsData[0] ?? null;
          const children = folderContents.map((c: any) => ({
            name: c.name,
            path: c.path,
            type: c.type,
            size: c.size,
            sha: c.sha,
            htmlUrl: c.html_url,
            gitUrl: c.git_url,
            downloadUrl: c.download_url ?? null,
            ext: c.name.includes(".")
              ? (c.name.split(".").pop()?.toLowerCase() ?? "")
              : "",
          }));
          const subtreeFlat = flattenTree(
            hit.originalChildren,
            hit.fileDetails?.depth ?? 1,
          );
          const subtreeFiles = subtreeFlat.filter((e) => e.type === "file");
          const subtreeFolders = subtreeFlat.filter((e) => e.type === "folder");
          const extFreq: Record<string, number> = {};
          for (const e of subtreeFiles) {
            if (e.ext) extFreq[e.ext] = (extFreq[e.ext] ?? 0) + 1;
          }
          const dominantExt =
            Object.entries(extFreq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
          const childNames = children.map((c) => c.name.toLowerCase());
          const hasIndex = childNames.some((n) =>
            /^index\.|^main\.|^app\./.test(n),
          );
          const hasConfig = childNames.some(
            (n) => n.includes("config") || n.endsWith(".json"),
          );
          const hasReadme = childNames.some((n) => n === "readme.md");
          const hasTests = childNames.some((n) =>
            /test|spec|__tests__/.test(n),
          );
          const hasStyles = childNames.some((n) =>
            /\.css$|\.scss$|\.sass$/.test(n),
          );
          const hasDotfiles = childNames.some((n) => n.startsWith("."));
          const folderContext = {
            id: hit.id,
            name: hit.name,
            path: hit.fileDetails?.path ?? hit.id,
            depth: hit.fileDetails?.depth ?? 0,
            size: hit.size,
            branchWeight: hit.fileDetails?.branchWeight ?? 0,
            isLarge: hit.fileDetails?.isLarge ?? false,
            children,
            lastCommit: lastCommit
              ? {
                  sha: lastCommit.sha,
                  message: lastCommit.commit.message,
                  author: lastCommit.commit.author.name,
                  authorEmail: lastCommit.commit.author.email,
                  date: lastCommit.commit.author.date,
                  htmlUrl: lastCommit.html_url,
                  avatarUrl: lastCommit.author?.avatar_url ?? null,
                  authorProfileUrl: lastCommit.author?.html_url ?? null,
                  shortSha: lastCommit.sha.slice(0, 7),
                }
              : null,
            subtree: subtreeFlat,
            stats: {
              totalFiles: subtreeFiles.length,
              totalFolders: subtreeFolders.length,
              totalSize: subtreeFiles.reduce((acc, e) => acc + e.size, 0),
              maxDepth: subtreeFlat.reduce(
                (acc, e) => Math.max(acc, e.depth),
                0,
              ),
              extFrequency: extFreq,
              dominantExt,
            },
            flags: {
              hasIndex,
              hasConfig,
              hasReadme,
              hasTests,
              hasStyles,
              hasDotfiles,
              isEntryPoint: hasIndex,
              isConfigFolder: hasConfig && !hasIndex,
              isTestFolder: hasTests && subtreeFiles.length > 0,
            },
          };
          setFolderContext(folderContext);
          setSelection("folder", hit.name, hit.id, folderContext);
        } catch {
          setSelection("folder", hit.name, hit.id, null);
        }
      } else if (hit.type === "file") {
        try {
          const encodedPath = encodeURIComponent(hit.id);
          const [contentRes, historyRes] = await Promise.allSettled([
            fetch(
              `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`,
              { headers },
            ),
            fetch(
              `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodedPath}&per_page=100`,
              { headers },
            ),
          ]);
          if (contentRes.status === "rejected" || !contentRes.value.ok)
            throw new Error("Failed to fetch file content");
          const contentData = await contentRes.value.json();
          const historyData: any[] =
            historyRes.status === "fulfilled" && historyRes.value.ok
              ? await historyRes.value.json()
              : [];
          let rawContent = "";
          if (contentData.encoding === "base64")
            rawContent = atob(contentData.content.replace(/\n/g, ""));
          const lines = rawContent.split("\n");
          const lineCount = lines.length,
            charCount = rawContent.length;
          const commits = historyData.map((c: any) => ({
            sha: c.sha,
            shortSha: c.sha.slice(0, 8),
            message: c.commit.message,
            author: c.commit.author.name,
            authorEmail: c.commit.author.email,
            date: c.commit.author.date,
            htmlUrl: c.html_url,
            avatarUrl: c.author?.avatar_url ?? null,
            profileUrl: c.author?.html_url ?? null,
            committer: c.commit.committer.name,
            committerEmail: c.commit.committer.email,
            verified: c.commit.verification?.verified ?? false,
          }));
          const contribMap = new Map<
            string,
            {
              name: string;
              email: string;
              avatarUrl: string | null;
              profileUrl: string | null;
              commits: number;
              firstCommit: string;
              lastCommit: string;
            }
          >();
          for (const c of historyData) {
            const key = c.commit.author.email;
            if (!contribMap.has(key))
              contribMap.set(key, {
                name: c.commit.author.name,
                email: key,
                avatarUrl: c.author?.avatar_url ?? null,
                profileUrl: c.author?.html_url ?? null,
                commits: 0,
                firstCommit: c.commit.author.date,
                lastCommit: c.commit.author.date,
              });
            const entry = contribMap.get(key)!;
            entry.commits++;
            if (c.commit.author.date < entry.firstCommit)
              entry.firstCommit = c.commit.author.date;
            if (c.commit.author.date > entry.lastCommit)
              entry.lastCommit = c.commit.author.date;
          }
          const contributors = Array.from(contribMap.values()).sort(
            (a, b) => b.commits - a.commits,
          );
          const topContributor = contributors[0] ?? null;
          const emptyLines = lines.filter((l) => l.trim() === "").length;
          const commentLines = lines.filter((l) =>
            /^\s*(\/\/|#|\/\*|\*|<!--)/.test(l),
          ).length;
          const codeLines = lineCount - emptyLines - commentLines;
          const importLines = rawContent.match(/^import .+/gm) ?? [];
          const exportSymbols =
            rawContent.match(
              /export\s+(default\s+)?(const|function|class|type|interface|enum)\s+(\w+)/g,
            ) ?? [];
          const todoComments =
            rawContent.match(/\/\/\s*(TODO|FIXME|HACK|NOTE|XXX):?.+/gi) ?? [];
          const consoleLogs =
            rawContent.match(/console\.(log|warn|error|info|debug)\(/g) ?? [];
          const branchKeywords = (
            rawContent.match(/\bif\b|\belse\b|\bswitch\b|\bcase\b|\b\?\s/g) ??
            []
          ).length;
          const loopKeywords = (
            rawContent.match(
              /\bfor\b|\bwhile\b|\bdo\b|\b\.map\b|\b\.filter\b|\b\.reduce\b/g,
            ) ?? []
          ).length;
          const asyncKeywords = (
            rawContent.match(/\basync\b|\bawait\b|\b\.then\b|\b\.catch\b/g) ??
            []
          ).length;
          const functionCount = (
            rawContent.match(/\bfunction\b|\b=>\s*[{(]/g) ?? []
          ).length;
          const classCount = (rawContent.match(/\bclass\s+\w+/g) ?? []).length;
          const isReact = /import\s+.*React|from\s+['"]react['"]/.test(
            rawContent,
          );
          const isTypeScript = hit.ext === "ts" || hit.ext === "tsx";
          const isTest =
            /\.(test|spec)\.[a-z]+$/.test(hit.name) ||
            /describe\(|it\(|test\(/.test(rawContent);
          const isConfig = /config|\.env|rc\b/.test(hit.name.toLowerCase());
          const hasJsx = /<[A-Z][A-Za-z]*[\s/>]|<\/[A-Z]/.test(rawContent);
          const logicType = isTest
            ? "Test / Spec"
            : isConfig
              ? "Config / Env"
              : isReact && hasJsx
                ? "UI Component (JSX)"
                : isReact
                  ? "React Hook / Utility"
                  : "Logic / Utility / Backend";
          const fileContext = {
            id: hit.id,
            name: hit.name,
            path: hit.fileDetails?.path ?? hit.id,
            ext: hit.ext,
            depth: hit.fileDetails?.depth ?? 0,
            isLarge: hit.fileDetails?.isLarge ?? false,
            github: {
              sha: contentData.sha,
              size: contentData.size,
              encoding: contentData.encoding,
              htmlUrl: contentData.html_url,
              gitUrl: contentData.git_url,
              downloadUrl: contentData.download_url ?? null,
              type: contentData.type,
            },
            content: rawContent,
            metrics: {
              lineCount,
              charCount,
              codeLines,
              commentLines,
              emptyLines,
              byteSize: contentData.size,
            },
            analysis: {
              imports: importLines.map((l) =>
                l.replace(/^import\s+/, "").trim(),
              ),
              exports: exportSymbols.map((e) =>
                e.replace(/^export\s+(default\s+)?/, "").trim(),
              ),
              todoComments,
              consoleLogs: consoleLogs.length,
              functionCount,
              classCount,
              complexity: {
                score: branchKeywords + loopKeywords,
                branches: branchKeywords,
                loops: loopKeywords,
                asyncOps: asyncKeywords,
              },
              logicType,
              isReact,
              isTypeScript,
              isTest,
              isConfig,
              hasJsx,
            },
            commits,
            contributors,
            topContributor,
            firstCommit:
              commits.length > 0 ? commits[commits.length - 1] : null,
            latestCommit: commits.length > 0 ? commits[0] : null,
          };
          setFileContext(fileContext);
          setSelection("file", hit.name, hit.id, fileContext);
          setActiveFile({
            node: hit,
            content: rawContent,
            imageDataUrl: undefined,
            history: historyData[0] || null,
          });
        } catch (err: any) {
          console.error("File selection error:", err.message);
        }
      } else if (hit.type === "root") {
        const existing = useSelectionStore.getState().selection.repoContext;
        if (existing) {
          useSelectionStore.getState().setRepoContext(existing);
        } else {
          setSelection("repo", data.details?.name ?? "Root", "/", null);
        }
      }
    },
    [
      hitTest,
      toggleFolder,
      data,
      setSelection,
      setFolderContext,
      setFileContext,
    ],
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
              { l: "Watch", v: rc?.github?.watchers ?? 0, c: "#34d399" },
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
              {
                k: "Files",
                v: rc ? `${rc.stats.totalFiles}` : null,
                c: "#94a3b8",
              },
              { k: "Items", v: rc?.stats.rootItemCount, c: "#34d399" },
              { k: "Branch", v: rc?.meta.defaultBranch, c: "#67e8f9" },
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
              <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm bg-gray-900/50 border border-gray-800 text-gray-500 shrink-0 group-hover:text-blue-400 group-hover:border-blue-500/30 transition-colors">
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
                  : `${node.fileDetails?.branchWeight ?? "\u2014"}`,
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
        {fctx && (
          <>
            <div className="grid grid-cols-3 gap-1">
              {[
                { v: fctx.metrics.lineCount, l: "Lines", c: "#94a3b8" },
                { v: fctx.analysis.functionCount, l: "Funcs", c: "#818cf8" },
                {
                  v: fctx.analysis.complexity.score,
                  l: "Cmplx",
                  c:
                    fctx.analysis.complexity.score > 20 ? "#f87171" : "#34d399",
                },
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
                  <div className="text-[7px] text-gray-600 uppercase">
                    {s.l}
                  </div>
                </div>
              ))}
            </div>
            {fctx.latestCommit && (
              <div className="border-t border-gray-700 pt-2">
                <div className="text-[8px] text-gray-500 uppercase tracking-wider mb-1">
                  Last Commit
                </div>
                <div className="text-[9px] text-gray-300 truncate font-medium">
                  {fctx.latestCommit.message.split("\n")[0].slice(0, 40)}
                </div>
                <div className="text-[8px] text-gray-500 font-mono mt-0.5">
                  {fctx.latestCommit.author} \u00b7 {fctx.latestCommit.shortSha}
                </div>
              </div>
            )}
          </>
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
        {/* Sidebar legend */}
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

        {/* Canvas */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 cursor-default"
          style={{ right: sidebarWidth }} // This will automatically adapt to your narrower sidebar
          onClick={onClick}
          onMouseMove={onMouseMove}
          onMouseLeave={() => {
            setTooltip(null);
            if (canvasRef.current) canvasRef.current.style.cursor = "default";
          }}
        />

        {/* Rich tooltip */}
        {tooltip && (
          <div
            className="absolute z-20 pointer-events-none px-3 py-2.5 rounded-xl font-mono shadow-2xl"
            style={{
              left: tooltip.x + 15, // Brought closer to the node
              top: Math.min(
                tooltip.y - 8,
                (treeContainerRef.current?.clientHeight ?? 400) - 300, // Adjusted max-height constraint for compact height
              ),
              background: "#0f172a", // Sleeker, darker slate
              border: "1px solid #334155", // Reduced weight from 2px to 1px
              borderRadius: "12px", // Slightly tighter radius for smaller popups
              boxShadow: "0 20px 50px rgba(0,0,0,0.5)",
            }}
          >
            {renderTooltipContent(tooltip.node)}
          </div>
        )}
      </div>

      {/* Drag divider */}
      {activeFile && topPx !== null && (
        <div
          className="absolute left-0 right-0 z-30 flex items-center justify-center group"
          style={{ top: topPx, height: 4, cursor: "row-resize" }} // Reduced height from 6 to 4
          onMouseDown={onDragStart}
        >
          <div
            className="absolute inset-0 transition-colors"
            style={{ background: "rgba(30,41,59,0.4)" }} // Slightly more transparent
          />
          <div
            className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ background: "rgba(59,130,246,0.2)" }} // Softer hover glow
          />
          <div
            className="relative z-10 flex items-center gap-1 px-2 py-0.5 rounded-full pointer-events-none" // Reduced px-3 to px-2
            style={{
              background: "rgba(10,16,28,0.95)",
              border: "1px solid rgba(51,65,85,0.8)", // Sharper border color
            }}
          >
            <GripHorizontal
              size={9} // Reduced size from 10 to 9
              className="text-slate-600 group-hover:text-blue-400 transition-colors"
            />
          </div>
        </div>
      )}

      {/* Inspector pane */}
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
            className="shrink-0 flex items-center gap-2.5 px-3 py-2" // Reduced px-4 to px-3 and py-2.5 to py-2
            style={{
              background: fc
                ? hexToRgba(fc.color, 0.03)
                : "rgba(10,15,26,0.85)", // Subtle decrease in bg opacity
              borderBottom: `1px solid ${fc ? hexToRgba(fc.color, 0.08) : "rgba(30,41,59,0.5)"}`, // Thinner-feeling border
            }}
          >
            <div
              className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center" // Shrunk from w-8 to w-7, radius xl to lg
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
              {storeFileContext && (
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

          {/* Body */}
          <div className="flex flex-1 min-h-0">
            {/* Source */}
            <div
              className="flex flex-col border-r overflow-hidden"
              style={{ width: "58%", borderColor: "rgba(30,41,59,0.5)" }} // Slightly lighter, thinner border
            >
              <div
                className="shrink-0 flex items-center gap-2 px-3 py-1.5" // Reduced px-4 py-2
                style={{
                  borderBottom: "1px solid rgba(30,41,59,0.4)",
                  background: "rgba(4,7,14,0.7)",
                }}
              >
                <Code2 size={10} className="text-slate-600" />
                <span className="text-[9px] font-mono font-bold text-slate-600 uppercase tracking-widest">
                  {activeFile.imageDataUrl ? "Preview" : "Source"}
                </span>
                {storeFileContext && (
                  <span className="ml-auto text-[9px] font-mono text-slate-600">
                    {storeFileContext.metrics.codeLines}c ·{" "}
                    {storeFileContext.metrics.commentLines}
                    {" // · "}
                    {storeFileContext.metrics.emptyLines}Ø
                  </span>
                )}
              </div>
              <div
                className="flex-1 overflow-auto bg-[#020408]" // Slightly deeper black
              >
                {activeFile.imageDataUrl ? (
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
                      padding: "16px", // Reduced from 20px
                      fontSize: "12px", // Reduced from 13px
                      background: "transparent",
                      lineHeight: "1.5", // Tightened from 1.65
                    }}
                    showLineNumbers={true}
                    lineNumberStyle={{
                      minWidth: "2.5em", // Shrunk from 3em
                      paddingRight: "1em",
                      color: "#1e293b", // Slate-800 for more subtle line numbers
                      textAlign: "right",
                      userSelect: "none",
                    }}
                  >
                    {activeFile.content}
                  </SyntaxHighlighter>
                )}
              </div>
            </div>

            {/* Details */}
            <div
              className="flex flex-col overflow-auto"
              style={{ width: "42%", background: "#040810" }}
            >
              {storeFileContext ? (
                <div className="p-4 space-y-5">
                  {/* Metrics */}
                  <>
                    <div className="flex items-center gap-1.5 mb-2">
                      <BarChart2 size={10} className="text-slate-700" />
                      <span className="text-[9px] font-mono font-bold text-slate-700 uppercase tracking-widest">
                        Metrics
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-1">
                      <StatPill
                        icon={FileText}
                        label="Lines"
                        value={storeFileContext.metrics.lineCount.toLocaleString()}
                        accent="#94a3b8"
                      />
                      <StatPill
                        icon={Code2}
                        label="Code"
                        value={storeFileContext.metrics.codeLines.toLocaleString()}
                        accent="#60a5fa"
                      />
                      <StatPill
                        icon={Hash}
                        label="Blank"
                        value={storeFileContext.metrics.emptyLines}
                        accent="#475569"
                      />
                      <StatPill
                        icon={Cpu}
                        label="Functions"
                        value={storeFileContext.analysis.functionCount}
                        accent="#818cf8"
                      />
                      <StatPill
                        icon={Box}
                        label="Classes"
                        value={storeFileContext.analysis.classCount}
                        accent="#a78bfa"
                      />
                      <StatPill
                        icon={Zap}
                        label="Cmplx"
                        value={storeFileContext.analysis.complexity.score}
                        accent={
                          storeFileContext.analysis.complexity.score > 20
                            ? "#f87171"
                            : storeFileContext.analysis.complexity.score > 10
                              ? "#fbbf24"
                              : "#34d399"
                        }
                      />
                    </div>
                  </>

                  {/* Analysis */}
                  <>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Terminal size={10} className="text-slate-700" />
                      <span className="text-[9px] font-mono font-bold text-slate-700 uppercase tracking-widest">
                        Analysis
                      </span>
                    </div>
                    <div className="space-y-1 text-[10px]">
                      {[
                        {
                          k: "Type",
                          v: storeFileContext.analysis.logicType,
                          c: "#94a3b8",
                        },
                        {
                          k: "Branches",
                          v: storeFileContext.analysis.complexity.branches,
                          c: "#fbbf24",
                        },
                        {
                          k: "Loops",
                          v: storeFileContext.analysis.complexity.loops,
                          c: "#fb923c",
                        },
                        {
                          k: "Async ops",
                          v: storeFileContext.analysis.complexity.asyncOps,
                          c: "#67e8f9",
                        },
                        {
                          k: "console.log",
                          v: storeFileContext.analysis.consoleLogs,
                          c:
                            storeFileContext.analysis.consoleLogs > 0
                              ? "#fbbf24"
                              : "#334155",
                        },
                        {
                          k: "Imports",
                          v: storeFileContext.analysis.imports.length,
                          c: "#94a3b8",
                        },
                        {
                          k: "Exports",
                          v: storeFileContext.analysis.exports.length,
                          c: "#94a3b8",
                        },
                      ].map((r) => (
                        <div key={r.k} className="flex justify-between">
                          <span className="text-slate-600">{r.k}</span>
                          <span className="font-mono" style={{ color: r.c }}>
                            {r.v}
                          </span>
                        </div>
                      ))}
                    </div>

                    <div className="flex flex-wrap gap-1 mt-2">
                      {storeFileContext.analysis.isReact && (
                        <Badge color="#61dafb">React</Badge>
                      )}
                      {storeFileContext.analysis.isTypeScript && (
                        <Badge color="#3b82f6">TS</Badge>
                      )}
                      {storeFileContext.analysis.hasJsx && (
                        <Badge color="#f472b6">JSX</Badge>
                      )}
                      {storeFileContext.analysis.isTest && (
                        <Badge color="#34d399">Test</Badge>
                      )}
                      {storeFileContext.analysis.isConfig && (
                        <Badge color="#fbbf24">Config</Badge>
                      )}
                    </div>

                    {storeFileContext.analysis.todoComments.length > 0 && (
                      <div
                        className="mt-2 p-2 rounded-md border"
                        style={{
                          background: "rgba(251,191,36,0.02)",
                          borderColor: "rgba(251,191,36,0.08)",
                        }}
                      >
                        <div className="text-[8px] text-yellow-700/80 uppercase tracking-wider mb-1">
                          {storeFileContext.analysis.todoComments.length} TODO
                          {storeFileContext.analysis.todoComments.length > 1
                            ? "s"
                            : ""}
                        </div>
                        {storeFileContext.analysis.todoComments
                          .slice(0, 3)
                          .map((t, i) => (
                            <div
                              key={i}
                              className="text-[9px] text-yellow-500/50 font-mono truncate leading-tight"
                            >
                              {t.trim()}
                            </div>
                          ))}
                      </div>
                    )}
                  </>

                  {/* File info */}
                  <>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Layers size={10} className="text-slate-700" />
                      <span className="text-[9px] font-mono font-bold text-slate-700 uppercase tracking-widest">
                        File Info
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-1">
                      <StatPill
                        icon={HardDrive}
                        label="Size"
                        value={`${(storeFileContext.github.size / 1024).toFixed(1)} KB`}
                        accent={
                          storeFileContext.isLarge ? "#fb923c" : "#60a5fa"
                        }
                      />
                      <StatPill
                        icon={Hash}
                        label="Depth"
                        value={`L${storeFileContext.depth}`}
                        accent="#64748b"
                      />
                      <StatPill
                        icon={FileCode2}
                        label="Ext"
                        value={
                          storeFileContext.ext
                            ? `.${storeFileContext.ext}`
                            : "none"
                        }
                        accent={fc?.color ?? "#94a3b8"}
                      />
                      <StatPill
                        icon={Calendar}
                        label="Modified"
                        value={
                          storeFileContext.latestCommit
                            ? new Date(
                                storeFileContext.latestCommit.date,
                              ).toLocaleDateString()
                            : "\u2014"
                        }
                        accent="#c084fc"
                      />
                    </div>
                    <div className="mt-1">
                      <StatPill
                        icon={FolderTree}
                        label="Path"
                        value={storeFileContext.path}
                        accent="#475569"
                      />
                    </div>
                    {storeFileContext.isLarge && (
                      <div
                        className="mt-1 flex items-center gap-1.5 px-2 py-1.5 rounded-md border"
                        style={{
                          background: "rgba(251,146,60,0.03)",
                          borderColor: "rgba(251,146,60,0.12)",
                        }}
                      >
                        <div className="w-1 h-1 rounded-full bg-orange-400/70 animate-pulse" />
                        <span className="text-[9px] text-orange-400/70">
                          Large file — exceeds 500 KB
                        </span>
                      </div>
                    )}
                  </>

                  {/* Contributors */}
                  {storeFileContext.contributors.length > 0 && (
                    <div>
                      <div className="flex items-center gap-1.5 mb-2">
                        <Users size={10} className="text-slate-700" />
                        <span className="text-[9px] font-mono font-bold text-slate-700 uppercase tracking-widest">
                          Contributors ({storeFileContext.contributors.length})
                        </span>
                      </div>
                      <div className="space-y-1">
                        {storeFileContext.contributors.slice(0, 4).map((c) => (
                          <div
                            key={c.email}
                            className="flex items-center gap-2 px-2 py-1.5 rounded-md"
                            style={{
                              background: "rgba(255,255,255,0.02)",
                              border: "1px solid rgba(255,255,255,0.03)",
                            }}
                          >
                            {c.avatarUrl ? (
                              <img
                                src={c.avatarUrl}
                                className="w-5 h-5 rounded-full border border-white/5 shrink-0"
                                alt=""
                              />
                            ) : (
                              <div className="w-5 h-5 rounded-full bg-slate-900 border border-slate-800 shrink-0 flex items-center justify-center">
                                <span className="text-[8px] text-slate-600">
                                  {c.name[0]}
                                </span>
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="text-[10px] text-slate-300 font-medium truncate">
                                {c.name}
                              </div>
                              <div className="text-[8px] text-slate-600 font-mono leading-none">
                                {c.firstCommit.slice(0, 10)} →{" "}
                                {c.lastCommit.slice(0, 10)}
                              </div>
                            </div>
                            <div className="text-[10px] font-mono font-bold text-slate-600 shrink-0">
                              {c.commits}c
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Commit history */}
                  {storeFileContext.commits.length > 0 && (
                    <div>
                      <div className="flex items-center gap-1.5 mb-2">
                        <GitCommit size={10} className="text-slate-700" />
                        <span className="text-[9px] font-mono font-bold text-slate-700 uppercase tracking-widest">
                          History ({storeFileContext.commits.length})
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        {storeFileContext.commits.slice(0, 5).map((c) => (
                          <a
                            key={c.sha}
                            href={c.htmlUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-start gap-2 px-2 py-1.5 rounded-md transition-colors group"
                            style={{
                              border: "1px solid rgba(255,255,255,0.02)",
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background =
                                "rgba(255,255,255,0.035)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = "transparent";
                            }}
                          >
                            <span className="text-[8px] font-mono text-slate-700 mt-0.5 shrink-0 group-hover:text-blue-500 transition-colors">
                              {c.shortSha}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="text-[10px] text-slate-400 truncate leading-tight">
                                {c.message.split("\n")[0]}
                              </div>
                              <div className="text-[8px] text-slate-700 mt-0.5 font-mono">
                                {c.author} ·{" "}
                                {new Date(c.date).toLocaleDateString()}
                                {c.verified ? " ✓" : ""}
                              </div>
                            </div>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* GitHub link */}
                  <Link
                    href={storeFileContext.github.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all"
                    style={{
                      color: "#475569",
                      background: "rgba(255,255,255,0.02)",
                      border: "1px solid rgba(255,255,255,0.05)",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "#60a5fa";
                      e.currentTarget.style.borderColor =
                        "rgba(96,165,250,0.18)";
                      e.currentTarget.style.background =
                        "rgba(255,255,255,0.04)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "#475569";
                      e.currentTarget.style.borderColor =
                        "rgba(255,255,255,0.05)";
                      e.currentTarget.style.background =
                        "rgba(255,255,255,0.02)";
                    }}
                  >
                    <Eye size={10} />
                    View on GitHub
                  </Link>
                </div>
              ) : (
                /* Fallback when store not yet populated */
                <div className="p-2.5 space-y-3.5">
                  {activeFile.history && (
                    <div className="pb-3 border-b border-white/5">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <GitCommit size={10} className="text-slate-600" />
                        <span className="text-[9px] font-mono font-bold text-slate-600 uppercase tracking-widest">
                          Last Commit
                        </span>
                      </div>
                      <div
                        className="flex items-start gap-2 rounded-md p-2 border"
                        style={{
                          background: "rgba(255,255,255,0.015)",
                          borderColor: "rgba(255,255,255,0.04)",
                        }}
                      >
                        {activeFile.history.author?.avatar_url && (
                          <img
                            src={activeFile.history.author.avatar_url}
                            className="w-6 h-6 rounded-sm border border-white/5 shrink-0"
                            alt="author"
                          />
                        )}
                        <div className="min-w-0">
                          <p className="text-[10px] text-slate-300 font-medium leading-tight line-clamp-2">
                            {activeFile.history.commit.message}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[9px] text-blue-400/80">
                              {activeFile.history.commit.author.name}
                            </span>
                            <span className="text-[8px] text-slate-600 font-mono">
                              {activeFile.history.sha?.slice(0, 7)}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Layers size={10} className="text-slate-600" />
                      <span className="text-[9px] font-mono font-bold text-slate-600 uppercase tracking-widest">
                        File Info
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-1">
                      <StatPill
                        icon={HardDrive}
                        label="Size"
                        value={`${(activeFile.node.size / 1024).toFixed(1)} KB`}
                        accent={
                          activeFile.node.fileDetails?.isLarge
                            ? "#fb923c"
                            : "#60a5fa"
                        }
                      />
                      <StatPill
                        icon={Hash}
                        label="Depth"
                        value={`L${activeFile.node.fileDetails?.depth}`}
                        accent="#64748b"
                      />
                      <StatPill
                        icon={FileCode2}
                        label="Ext"
                        value={
                          activeFile.node.ext
                            ? `.${activeFile.node.ext}`
                            : "none"
                        }
                        accent={fc?.color ?? "#94a3b8"}
                      />
                      <StatPill
                        icon={Calendar}
                        label="Modified"
                        value={
                          activeFile.history?.commit?.author?.date
                            ? new Date(
                                activeFile.history.commit.author.date,
                              ).toLocaleDateString()
                            : "—"
                        }
                        accent="#c084fc"
                      />
                    </div>
                    <div className="mt-1">
                      <StatPill
                        icon={FolderTree}
                        label="Path"
                        value={activeFile.node.fileDetails?.path ?? ""}
                        accent="#475569"
                      />
                    </div>
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
