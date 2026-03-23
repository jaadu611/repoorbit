import {
  bufferCachedFile,
  flushCachedRepo,
  clearFileCache,
} from "@/lib/serverCache";

const token = (
  process.env.GITHUB_TOKEN ||
  process.env.NEXT_PUBLIC_GITHUB_TOKEN ||
  ""
)
  .trim()
  .replace(/^["']|["']$/g, "");

const CONCURRENCY_LIMIT = 20;
const GRAPHQL_BATCH_SIZE = 80;

const SKIP_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "ico",
  "webp",
  "bmp",
  "tiff",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "otf",
  "mp4",
  "mp3",
  "wav",
  "ogg",
  "webm",
  "zip",
  "tar",
  "gz",
  "lock",
  "map",
  "pdf",
  "docx",
  "xlsx",
]);

const SKIP_PATH_PATTERNS = [/\.d\.ts$/, /\.d\.mts$/, /\.d\.cts$/];

const MAX_FILE_SIZE_BYTES = 150_000;

function parseImports(content: string): string[] {
  const results: string[] = [];
  const importRegex = /(?:import|from)\s+['"]([^'"]+)['"]/g;
  const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(content)) !== null) results.push(m[1]);
  while ((m = requireRegex.exec(content)) !== null) results.push(m[1]);
  return results.filter((i) => i.startsWith(".") || i.startsWith("/"));
}

function resolveImportPath(
  importPath: string,
  fromFilePath: string,
): string | null {
  const dir = fromFilePath.split("/").slice(0, -1).join("/");
  const parts = (dir ? dir + "/" + importPath : importPath).split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else if (part !== ".") resolved.push(part);
  }
  return resolved.join("/") || null;
}

async function fetchFileContentsBatch(
  owner: string,
  repo: string,
  files: any[],
  ref: string,
  retries = 2,
): Promise<Map<string, string>> {
  const fields = files
    .map(
      (f, i) =>
        `f${i}: object(expression: "${ref}:${f.path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}") { ... on Blob { text } }`,
    )
    .join("\n");

  const query = `{ repository(owner: "${owner}", name: "${repo}") { ${fields} } }`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
    });

    if (res.status === 429 || res.status === 403) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 10);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    if (!res.ok) return new Map();
    const data = await res.json();

    const repoData = data.data?.repository ?? {};
    const result = new Map<string, string>();
    files.forEach((f, i) => {
      const text = repoData[`f${i}`]?.text;
      if (typeof text === "string") result.set(f.path, text);
    });
    return result;
  }

  return new Map();
}

function analyzeFile(entry: any, content: string) {
  const lines = content.split("\n");
  const functionCount = (content.match(/\bfunction\b|\b=>\s*[{(]/g) ?? [])
    .length;
  const classCount = (content.match(/\bclass\s+\w+/g) ?? []).length;
  const isReact = /import\s+.*React|from\s+['"]react['"]/.test(content);
  const isTest =
    /\.(test|spec)\.[a-z]+$/.test(entry.name) ||
    /describe\(|it\(|test\(/.test(content);
  const isConfig = /config|\.env|rc\b/.test(entry.name.toLowerCase());
  const isTypeScript = /\.(ts|tsx)$/.test(entry.name);
  const hasJsx = /\.(tsx|jsx)$/.test(entry.name) || /<[A-Z][A-Za-z0-9]*\s*\/?>/.test(content);

  const exportMatches = content.matchAll(
    /export\s+(?:default\s+)?(?:async\s+)?(?:(function|class|type|interface|enum)\s+(\w+)|const\s+(\w+)\s*=)/g,
  );
  const exports = [...exportMatches]
    .map((m) => (m[2] ?? m[3] ?? "").trim())
    .filter(Boolean);

  const todoComments = (content.match(/\/\/.*TODO:?.*$|#.*TODO:?.*$/gm) ?? []).map(t => t.replace(/^\s*\/\/\s*|^\s*#\s*/, ""));

  const commentLines = lines.filter((l) => /^\s*(\/\/|#|\/\*)/.test(l)).length;
  const emptyLines = lines.filter((l) => !l.trim()).length;
  const codeLines = lines.length - commentLines - emptyLines;

  return {
    exports,
    todoComments,
    functionCount,
    classCount,
    isReact,
    isTest,
    isConfig,
    isTypeScript,
    hasJsx,
    lineCount: lines.length,
    codeLines,
    emptyLines,
    commentLines,
    charCount: content.length,
    logicType: isTest
      ? "Test"
      : isConfig
        ? "Config"
        : isReact
          ? "React Logic"
          : "Core Logic",
  };
}

export async function POST(req: Request) {
  const { owner, repo, repoFullName, tree, defaultBranch } = await req.json();
  const encoder = new TextEncoder();
  const ref = defaultBranch ?? "main";

  clearFileCache(repoFullName);

  const allFiles = tree
    .filter((n: any) => {
      if (n.type !== "blob") return false;
      const ext = n.path.includes(".")
        ? n.path.split(".").pop()!.toLowerCase()
        : "";
      if (SKIP_EXTENSIONS.has(ext)) return false;
      if (SKIP_PATH_PATTERNS.some((re) => re.test(n.path))) return false;
      if ((n.size ?? 0) > MAX_FILE_SIZE_BYTES) return false;
      return true;
    })
    .map((n: any) => ({
      path: n.path,
      name: n.path.split("/").pop() ?? n.path,
      ext: n.path.includes(".") ? n.path.split(".").pop()!.toLowerCase() : "",
      size: n.size ?? 0,
      depth: n.path.split("/").length,
    }));

  const pathSet = new Set(allFiles.map((f: { path: string }) => f.path));

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
        } catch {}
      };

      try {
        let processedCount = 0;

        const batches: any[][] = [];
        for (let i = 0; i < allFiles.length; i += GRAPHQL_BATCH_SIZE) {
          batches.push(allFiles.slice(i, i + GRAPHQL_BATCH_SIZE));
        }

        const processBatch = async (batch: any[]) => {
          const contents = await fetchFileContentsBatch(
            owner,
            repo,
            batch,
            ref,
          );

          await Promise.all(
            Array.from(contents.entries()).map(async ([path, text]) => {
              const entry = batch.find(
                (f: { path: string }) => f.path === path,
              );
              const rawImports = parseImports(text);

              const resolvedImports: string[] = [];
              for (const imp of rawImports) {
                const base = resolveImportPath(imp, path);
                if (!base) continue;
                const candidates = base.includes(".")
                  ? [base]
                  : [
                      `${base}.ts`,
                      `${base}.tsx`,
                      `${base}.js`,
                      `${base}.jsx`,
                      `${base}/index.ts`,
                      `${base}/index.tsx`,
                      `${base}/index.js`,
                      `${base}/index.jsx`,
                    ];
                for (const c of candidates) {
                  if (pathSet.has(c)) {
                    resolvedImports.push(c);
                    break;
                  }
                }
              }

              const analysis = analyzeFile(entry, text);

              bufferCachedFile(repoFullName, {
                path,
                content: text,
                analysis,
                metrics: {
                  lineCount: analysis.lineCount,
                  codeLines: analysis.codeLines,
                  emptyLines: analysis.emptyLines,
                  commentLines: analysis.commentLines,
                  charCount: analysis.charCount,
                },
                imports: resolvedImports,
              });

              send({
                type: "file_data",
                file: {
                  path,
                  name: entry.name,
                  ext: entry.ext,
                  size: entry.size,
                  depth: entry.depth,
                  isLarge: entry.size > 1024 * 500,
                  imports: resolvedImports,
                  resolvedImports,
                  metrics: {
                    lineCount: analysis.lineCount,
                    codeLines: analysis.codeLines,
                    emptyLines: analysis.emptyLines,
                    commentLines: analysis.commentLines,
                    charCount: analysis.charCount,
                  },
                  analysis: {
                    exports: analysis.exports,
                    todoComments: analysis.todoComments,
                    functionCount: analysis.functionCount,
                    classCount: analysis.classCount,
                    logicType: analysis.logicType,
                    isReact: analysis.isReact,
                    isTypeScript: analysis.isTypeScript,
                    isTest: analysis.isTest,
                    isConfig: analysis.isConfig,
                    hasJsx: analysis.hasJsx,
                  },
                },
              });
            }),
          );

          processedCount += batch.length;
          send({
            type: "progress",
            percentage: Math.round((processedCount / allFiles.length) * 100),
          });
        };

        const pool = [...batches];
        const workers = Array(CONCURRENCY_LIMIT)
          .fill(null)
          .map(async () => {
            while (pool.length > 0) {
              const batch = pool.shift();
              if (batch) await processBatch(batch);
            }
          });

        await Promise.all(workers);
        await flushCachedRepo(repoFullName);

        send({ type: "done" });
        controller.close();
      } catch (err: any) {
        send({ type: "error", message: err.message });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
    },
  });
}
