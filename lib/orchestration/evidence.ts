import fs from "fs";
import path from "path";
import { BrowserContext } from "playwright";
import {
  automateNotebookLM,
  automateSubQuestion,
} from "@/lib/automation/notebooklm";
import {
  getNotebookSubQuestionPrompt,
  getGenericNotebookPrompt,
} from "@/lib/prompts";

export async function collectRelevantFiles(
  context: BrowserContext,
  _query: string,
  notebookPlans: any[],
  outDir: string,
  onStatus: (msg: string) => void,
): Promise<string[]> {
  const allFiles = new Set<string>();
  const notebooksPath = path.join(outDir, "notebooks.json");
  let notebooks: any[] = [];
  if (fs.existsSync(notebooksPath)) {
    try {
      notebooks = JSON.parse(fs.readFileSync(notebooksPath, "utf-8"));
    } catch {}
  }

  onStatus(
    `Querying ${notebookPlans.length} notebooks in parallel (concurrency limit: 5)...`,
  );

  const results: any[] = [];
  const CONCURRENCY_LIMIT = 5;

  for (let i = 0; i < notebookPlans.length; i += CONCURRENCY_LIMIT) {
    const batch = notebookPlans.slice(i, i + CONCURRENCY_LIMIT);
    const batchResults = await Promise.all(
      batch.map(async (plan) => {
        const nb = notebooks.find(
          (n) => n.name === plan.name || n.title === plan.name,
        );
        if (!nb) {
          console.warn(`[NotebookLM] Unknown notebook: ${plan.name}`);
          return [];
        }

        console.log(`[ORCHESTRATOR] Parallel Query: "${nb.title}"`);
        const page = await context.newPage();
        try {
          onStatus(`[NotebookLM] Investigating "${nb.title}"...`);
          const files = await automateSubQuestion(
            page,
            nb.title,
            getNotebookSubQuestionPrompt(plan.sub_question),
            nb.localFiles,
          );
          return Array.isArray(files) ? files : [];
        } catch (err: any) {
          console.error(`[NotebookLM] Error in "${nb.title}":`, err);
          return [];
        } finally {
          await page.close();
        }
      }),
    );
    results.push(...batchResults);
  }

  results.flat().forEach((f) => {
    if (f !== "notebook_instructions.txt" && f !== "00_manifest.txt")
      allFiles.add(f);
  });

  onStatus(`Total context files gathered: ${allFiles.size}`);
  return Array.from(allFiles);
}

export async function collectGenericAnswers(
  context: BrowserContext,
  notebookPlans: any[],
  outDir: string,
  onStatus: (msg: string) => void,
): Promise<{ sub_question: string; answer: string; notebook: string }[]> {
  const notebooksPath = path.join(outDir, "notebooks.json");
  let notebooks: any[] = [];
  if (fs.existsSync(notebooksPath)) {
    try {
      notebooks = JSON.parse(fs.readFileSync(notebooksPath, "utf-8"));
    } catch {}
  }

  onStatus(
    `Answering from ${notebookPlans.length} notebooks in parallel (concurrency limit: 5)...`,
  );

  const results: any[] = [];
  const CONCURRENCY_LIMIT = 5;

  for (let i = 0; i < notebookPlans.length; i += CONCURRENCY_LIMIT) {
    const batch = notebookPlans.slice(i, i + CONCURRENCY_LIMIT);
    const batchResults = await Promise.all(
      batch.map(async (plan) => {
        const nb = notebooks.find(
          (n) => n.name === plan.name || n.title === plan.name,
        );
        if (!nb) {
          console.warn(`[Generic] Unknown notebook: ${plan.name}`);
          return null;
        }

        const page = await context.newPage();
        try {
          onStatus(`[NotebookLM] Deep querying "${nb.title}"...`);
          const answer = await automateNotebookLM(
            page,
            nb.localFiles || [],
            getGenericNotebookPrompt(plan.sub_question),
            nb.title,
            (msg) => onStatus(`[NotebookLM] ${msg}`),
            false,
          );
          return {
            sub_question: plan.sub_question,
            answer,
            notebook: nb.title,
          };
        } catch (err: any) {
          return {
            sub_question: plan.sub_question,
            answer: `[Error: ${err.message}]`,
            notebook: nb.title,
          };
        } finally {
          await page.close();
        }
      }),
    );
    results.push(...batchResults);
  }

  return results.filter((a): a is any => a !== null);
}
