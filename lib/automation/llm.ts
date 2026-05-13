import OpenAI from "openai";
import { recordApiCall } from "@/lib/orchestration/tokenTracker";

export type NVIDIA_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1";

export const DEFAULT_MODEL: NVIDIA_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1";

// Global taskId context so llm.ts can attribute calls to the right job
let _currentTaskId: string = "global";
let _currentRole: "engineer" | "reviewer" | "surgeon" | "test_diag" | "other" = "other";

export function setLLMContext(
  taskId: string,
  role: "engineer" | "reviewer" | "surgeon" | "test_diag" | "other",
) {
  _currentTaskId = taskId;
  _currentRole = role;
}

/**
 * Generic NVIDIA API caller for the primary model with Retry Logic.
 */
export async function askNvidia(
  model: NVIDIA_MODEL = DEFAULT_MODEL,
  messages: any[],
  onStatus?: (msg: string, partial?: string) => void,
  logPrefix: string = "[LLM]",
  maxRetries: number = 5,
): Promise<string> {
  const apiKey = process.env.NVIDIA_API_KEY || "";

  if (!apiKey) {
    const errorMsg = `[CREDENTIALS ERROR] Missing NVIDIA_API_KEY environment variable.`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: "https://integrate.api.nvidia.com/v1",
  });

  // Estimate input tokens for tracking
  const inputText = messages.map((m) => m.content || "").join("\n");

  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      if (onStatus)
        onStatus(`Calling ${DEFAULT_MODEL} (Attempt ${attempt + 1}/${maxRetries})...`);

      const params: any = {
        model: DEFAULT_MODEL,
        messages: messages,
        temperature: 0.1,
        top_p: 0.95,
        max_tokens: 16384,
        stream: true,
      };

      const startTime = Date.now();
      let firstChunkTime: number | null = null;

      const completion = (await client.chat.completions.create(params)) as any;

      let fullContent = "";
      for await (const chunk of completion) {
        if (firstChunkTime === null && chunk.choices[0]?.delta?.content) {
          firstChunkTime = Date.now();
        }
        const delta = chunk.choices[0]?.delta?.content || "";
        fullContent += delta;

        if (onStatus && fullContent.length % 50 === 0) {
          const preview = fullContent
            .substring(Math.max(0, fullContent.length - 100))
            .replace(/\n/g, " ");
          onStatus(`${DEFAULT_MODEL} generating...`, preview + "...");
        }
      }

      const endTime = Date.now();
      const durationMs = endTime - startTime;
      const ttftSec = firstChunkTime ? (firstChunkTime - startTime) / 1000 : 0;
      const charsPerSec = fullContent.length / (durationMs / 1000 || 1);

      console.log(
        `[PERF] ${DEFAULT_MODEL} — TTFT: ${ttftSec.toFixed(2)}s | Total: ${(durationMs / 1000).toFixed(2)}s | Speed: ${charsPerSec.toFixed(1)} chars/sec`,
      );
      console.log(
        `[LLM] ${DEFAULT_MODEL} - Received Answer:\n${fullContent}\n[END OF ${DEFAULT_MODEL} RESPONSE]`,
      );

      // Record for token tracking
      recordApiCall(
        _currentTaskId,
        DEFAULT_MODEL,
        _currentRole,
        inputText,
        fullContent,
        durationMs,
      );

      if (onStatus) onStatus(`${DEFAULT_MODEL} response complete.`);
      return fullContent;
    } catch (err: any) {
      attempt++;
      console.error(
        `${logPrefix} Attempt ${attempt} failed for ${DEFAULT_MODEL}:`,
        err.message,
      );

      if (attempt >= maxRetries) {
        throw new Error(
          `NVIDIA API failure (${DEFAULT_MODEL}) after ${maxRetries} attempts: ${err.message}`,
        );
      }

      let waitTime = Math.pow(2, attempt) * 2000;
      if (err.message.includes("429")) {
        waitTime = Math.max(waitTime, 10000 * attempt);
        if (onStatus)
          onStatus(
            `[RATE LIMIT] ${DEFAULT_MODEL} is throttled. Waiting ${waitTime / 1000}s...`,
          );
      } else {
        if (onStatus) onStatus(`Retrying ${DEFAULT_MODEL} in ${waitTime}ms...`);
      }

      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }
  throw new Error(`NVIDIA API failure (${DEFAULT_MODEL}): Unknown error`);
}
