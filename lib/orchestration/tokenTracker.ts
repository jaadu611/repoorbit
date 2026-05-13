/**
 * Token and cost tracking for all NVIDIA API calls within a job.
 * Nemotron-3 Super 120B pricing estimate: $4/1M input tokens, $12/1M output tokens
 * (approximate — update if NVIDIA publishes official rates)
 */

const COST_PER_1M_INPUT = 4.0;   // USD
const COST_PER_1M_OUTPUT = 12.0; // USD
const CHARS_PER_TOKEN = 3.8;     // average for code/mixed content

export interface CallRecord {
  model: string;
  role: "engineer" | "reviewer" | "surgeon" | "test_diag" | "other";
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  timestamp: number;
}

export interface TokenStats {
  calls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
  durationMs: number;
  breakdown: CallRecord[];
}

// In-memory store per taskId
const jobStats = new Map<string, CallRecord[]>();

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Records a completed API call for a given job.
 */
export function recordApiCall(
  taskId: string,
  model: string,
  role: CallRecord["role"],
  inputText: string,
  outputText: string,
  durationMs: number,
): void {
  if (!jobStats.has(taskId)) jobStats.set(taskId, []);

  jobStats.get(taskId)!.push({
    model,
    role,
    inputTokens: estimateTokens(inputText),
    outputTokens: estimateTokens(outputText),
    durationMs,
    timestamp: Date.now(),
  });
}

/**
 * Returns aggregated token and cost stats for a job.
 */
export function getTokenStats(taskId: string): TokenStats {
  const records = jobStats.get(taskId) || [];

  const totalInputTokens = records.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutputTokens = records.reduce((s, r) => s + r.outputTokens, 0);
  const totalTokens = totalInputTokens + totalOutputTokens;
  const durationMs = records.reduce((s, r) => s + r.durationMs, 0);

  const estimatedCostUSD =
    (totalInputTokens / 1_000_000) * COST_PER_1M_INPUT +
    (totalOutputTokens / 1_000_000) * COST_PER_1M_OUTPUT;

  return {
    calls: records.length,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    estimatedCostUSD,
    durationMs,
    breakdown: records,
  };
}

/**
 * Formats token stats as a human-readable Markdown report.
 */
export function formatTokenReport(stats: TokenStats): string {
  const cost = stats.estimatedCostUSD.toFixed(4);
  const totalSecs = (stats.durationMs / 1000).toFixed(1);

  const byRole: Record<string, { calls: number; tokens: number }> = {};
  for (const r of stats.breakdown) {
    if (!byRole[r.role]) byRole[r.role] = { calls: 0, tokens: 0 };
    byRole[r.role].calls++;
    byRole[r.role].tokens += r.inputTokens + r.outputTokens;
  }

  const roleLines = Object.entries(byRole)
    .map(([role, d]) => `| ${role} | ${d.calls} | ${d.tokens.toLocaleString()} |`)
    .join("\n");

  return [
    "## 💰 Token & Cost Report",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total API Calls | ${stats.calls} |`,
    `| Input Tokens | ~${stats.totalInputTokens.toLocaleString()} |`,
    `| Output Tokens | ~${stats.totalOutputTokens.toLocaleString()} |`,
    `| Total Tokens | ~${stats.totalTokens.toLocaleString()} |`,
    `| Est. Cost | **$${cost}** |`,
    `| Total AI Time | ${totalSecs}s |`,
    "",
    "### Breakdown by Role",
    "| Role | Calls | Tokens |",
    "|------|-------|--------|",
    roleLines,
    "",
    `> *Pricing: $${COST_PER_1M_INPUT}/1M input, $${COST_PER_1M_OUTPUT}/1M output tokens (estimates)*`,
  ].join("\n");
}

/**
 * Clears stats for a completed job (call after persisting to disk).
 */
export function clearJobStats(taskId: string): void {
  jobStats.delete(taskId);
}
