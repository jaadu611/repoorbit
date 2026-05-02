import { MAX_LINES_PER_FILE } from "./constants";

export async function fetchFile(
  _outDir: string,
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  lineRange?: [number, number],
): Promise<string | null> {
  const safeBranch = branch && branch.trim() ? branch.trim() : "main";
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${safeBranch}/${filePath}`;
  console.log(`[GITHUB] Fetching: ${url}`);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[GITHUB] 404/Error: ${url} (Status: ${res.status})`);
      return null;
    }
    const text = await res.text();
    const lines = text.split("\n");

    console.log(
      `[GITHUB] Success: ${filePath} (${lines.length} lines). Preview: ${lines[0].substring(0, 50)}...`,
    );

    if (lineRange) {
      const startIdx = lineRange[0] > 0 ? lineRange[0] - 1 : 0;
      const endIdx =
        lineRange[1] > 0
          ? Math.min(lines.length - 1, lineRange[1] - 1)
          : lines.length - 1;
      const slice = lines.slice(startIdx, endIdx + 1);
      const MAX_RANGE_LIMIT = 2000;
      if (slice.length > MAX_RANGE_LIMIT) {
        return (
          slice.slice(0, MAX_RANGE_LIMIT).join("\n") +
          `\n\n// [TRUNCATED] Only first ${MAX_RANGE_LIMIT} lines of the requested range are shown.`
        );
      }
      return slice.join("\n");
    }

    if (lines.length > MAX_LINES_PER_FILE) {
      return (
        lines.slice(0, MAX_LINES_PER_FILE).join("\n") +
        `\n\n// [TRUNCATED] Only first ${MAX_LINES_PER_FILE} lines shown. Use "line_range": [start, end] to request more.`
      );
    }
    return text;
  } catch (err: any) {
    console.error(`[GITHUB] Error fetching ${url}:`, err.message);
    return `// Error fetching ${filePath}`;
  }
}
