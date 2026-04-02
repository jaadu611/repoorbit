import { parseRepoInput, fetchCommitsForPath, fetchFileContent, analyzeFile, parseImports } from "@/lib/github";
import { CommitDetail } from "@/lib/types";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const repo = url.searchParams.get("repo");
  const filePath = url.searchParams.get("path");

  if (!repo || !filePath) {
    return new Response("Missing repo or path param", { status: 400 });
  }

  const { owner, repo: repoName } = parseRepoInput(repo);

  const content = await fetchFileContent(owner, repoName, filePath);
  if (content === null) {
    return new Response("File not found on GitHub", { status: 404 });
  }

  const filename = filePath.split("/").pop() ?? filePath;
  const analysis = analyzeFile(filename, content);
  const imports = parseImports(content, filename);
  const metrics = {
    lineCount: analysis.lineCount,
    codeLines: analysis.codeLines,
    emptyLines: analysis.emptyLines,
    commentLines: analysis.commentLines,
    charCount: analysis.charCount,
  };

  const commits = await fetchCommitsForPath(owner, repoName, filePath);

  const contributorMap = new Map<string, any>();
  commits.forEach((c: CommitDetail) => {
    const key = c.author;
    if (!contributorMap.has(key)) {
      contributorMap.set(key, {
        name: c.author,
        email: c.authorEmail,
        avatarUrl: c.avatarUrl,
        profileUrl: c.profileUrl,
        commits: 1,
        lastCommit: c.date,
      });
    } else {
      const existing = contributorMap.get(key);
      existing.commits++;
      if (new Date(c.date) > new Date(existing.lastCommit)) {
        existing.lastCommit = c.date;
      }
    }
  });

  const contributors = Array.from(contributorMap.values()).sort(
    (a, b) => b.commits - a.commits,
  );

  return Response.json({
    path: filePath,
    content,
    analysis,
    metrics,
    imports,
    commits,
    contributors,
    latestCommit: commits[0] ?? null,
  });
}
