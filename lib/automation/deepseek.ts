import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";
import { NotebookPlan } from "@/lib/core/types";

// Keep the model name in a variable as requested
export const DEEPSEEK_MODEL = "deepseek-ai/deepseek-v4-pro";

const openai = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY || "",
  baseURL: "https://integrate.api.nvidia.com/v1",
});

/**
 * Replaces the browser-based askDeepseek with a direct API call to NVIDIA.
 */
export async function askDeepseek(
  _page: any, // Kept for signature compatibility but unused
  query: string,
  manifestContent: string,
  contextDir: string,
  onStatus?: (msg: string, partial?: string, progress?: number) => void,
  _outDir: string = "",
  isFirstTurn: boolean = true,
  logPrefix: string = "[Deepseek]",
): Promise<string> {
  onStatus?.("Preparing context...");

  let fullPrompt = "";

  // ── 1. System Context & Manifest ──────────────────────────────────────────
  if (isFirstTurn) {
    fullPrompt += `### REPOSITORY MANIFEST\n${manifestContent}\n\n`;
  }

  // ── 2. Add Context Files (from deepseek_context or extra directories) ──────
  if (contextDir && fs.existsSync(contextDir)) {
    const files = fs
      .readdirSync(contextDir)
      .filter((f) => f.endsWith(".js") || f.endsWith(".ts") || f.endsWith(".txt") || f.endsWith(".md"));
    
    if (files.length > 0) {
      fullPrompt += "### ADDITIONAL CONTEXT FILES\n";
      for (const file of files) {
        const content = fs.readFileSync(path.join(contextDir, file), "utf-8");
        fullPrompt += `\n--- FILE: ${file} ---\n${content}\n`;
      }
      fullPrompt += "\n";
    }
  }

  fullPrompt += query;

  try {
    onStatus?.("Calling NVIDIA API...");
    
    const completion = await openai.chat.completions.create({
      model: DEEPSEEK_MODEL,
      messages: [{ role: "user", content: fullPrompt }],
      temperature: 1,
      top_p: 0.95,
      max_tokens: 16384,
      // @ts-ignore - NVIDIA specific extension
      chat_template_kwargs: { thinking: false },
      stream: true,
    });

    let fullContent = "";
    for await (const chunk of completion) {
      const delta = chunk.choices[0]?.delta?.content || "";
      fullContent += delta;
      
      if (onStatus) {
        const preview = fullContent.substring(fullContent.length - 100).replace(/\n/g, " ");
        onStatus("Generating...", preview + "...");
      }
    }

    onStatus?.("Response complete.");
    return fullContent;
  } catch (err: any) {
    console.error(`${logPrefix} API Error:`, err);
    throw new Error(`NVIDIA API failure: ${err.message}`);
  }
}

/**
 * Dummy cleanup function to maintain compatibility.
 */
export function cleanupDeepseekTempFiles(_paths: string[]): void {
  // No longer needed for API approach
}

// ─── Response parser (Kept as is because it's still useful for parsing JSON from text) ──────────

export function parseNotebookPlan(raw: string): NotebookPlan {
  const attempts: Array<() => NotebookPlan | null> = [
    () => {
      try {
        return validatePlan(JSON.parse(raw.trim()));
      } catch {
        return null;
      }
    },
    () => {
      const m = raw.match(/```(?:[a-z]*)?\s*([\s\S]*?)```/i);
      if (!m) return null;
      try {
        return validatePlan(JSON.parse(stripAssignment(m[1].trim())));
      } catch {
        return null;
      }
    },
    () => {
      const m = raw.match(
        /(?:const|let|var)?\s*\w+\s*=\s*(\{[\s\S]*"notebooks"[\s\S]*\})/,
      );
      if (!m) return null;
      try {
        return validatePlan(JSON.parse(m[1]));
      } catch {
        return null;
      }
    },
    () => {
      const start = raw.indexOf('{"notebooks"');
      const altStart = raw.indexOf('{ "notebooks"');
      const idx = [start, altStart]
        .filter((i) => i >= 0)
        .sort((a, b) => a - b)[0];
      if (idx === undefined || idx < 0) return null;
      const slice = extractBalancedObject(raw, idx);
      if (!slice) return null;
      try {
        return validatePlan(JSON.parse(slice));
      } catch {
        return null;
      }
    },
    () => {
      const idx = raw.indexOf("{");
      if (idx < 0) return null;
      const slice = extractBalancedObject(raw, idx);
      if (!slice) return null;
      try {
        return validatePlan(JSON.parse(slice));
      } catch {
        return null;
      }
    },
  ];

  for (const attempt of attempts) {
    const result = attempt();
    if (result) return result;
  }

  throw new Error(
    `Could not parse NotebookPlan from Deepseek response.\n` +
      `Raw response (first 500 chars):\n${raw.slice(0, 500)}`,
  );
}

function stripAssignment(s: string): string {
  return s
    .replace(/^(?:(?:const|let|var)\s+)?\w+\s*=\s*/, "")
    .trimEnd()
    .replace(/;$/, "");
}

function extractBalancedObject(text: string, startIdx: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  let quoteChar = "";

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (inString) {
      if (ch === quoteChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quoteChar = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

function validatePlan(obj: unknown): NotebookPlan {
  if (
    !obj ||
    typeof obj !== "object" ||
    (!Array.isArray((obj as any).notebooks) &&
      typeof (obj as any).direct_answer !== "string")
  ) {
    throw new Error(
      "Invalid NotebookPlan shape: expected { notebooks: [...] } or { direct_answer: '...' }",
    );
  }

  const plan = obj as NotebookPlan;
  if (plan.direct_answer) return plan;
  if (!plan.notebooks || plan.notebooks.length === 0) {
    throw new Error("NotebookPlan has zero notebooks.");
  }

  for (const nb of plan.notebooks) {
    if (typeof nb.name !== "string" || typeof nb.sub_question !== "string") {
      throw new Error(
        `Invalid notebook entry — must have string "name" and "sub_question". Got: ${JSON.stringify(nb)}`,
      );
    }
    if (!nb.name.trim() || !nb.sub_question.trim()) {
      throw new Error(
        `Notebook entry has empty name or sub_question: ${JSON.stringify(nb)}`,
      );
    }
  }

  return plan;
}
