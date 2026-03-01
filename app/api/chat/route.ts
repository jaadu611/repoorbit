import { NextResponse } from "next/server";

const OLLAMA_URL = "http://127.0.0.1:11434/api/generate";

// works good kinda slow (4th)
// const OLLAMA_MODEL = "qwen2.5-coder:7b";

// fast af (2nd)
// const OLLAMA_MODEL = "qwen2.5-coder:3b";

// works way way better than expected (1st)
const OLLAMA_MODEL = "gemma3:4b";

// super slow but super detailed (3rd)
// const OLLAMA_MODEL = "Gemma:latest";

const OLLAMA_TIMEOUT_MS = 30_000;

export async function POST(req: Request) {
  try {
    const { prompt, stream: streamMode = true } = await req.json();

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid prompt" },
        { status: 400 },
      );
    }

    const abortController = new AbortController();

    req.signal.addEventListener("abort", () => abortController.abort());

    const timeoutId = setTimeout(
      () => abortController.abort(),
      OLLAMA_TIMEOUT_MS,
    );

    let ollamaResponse: Response;
    try {
      ollamaResponse = await fetch(OLLAMA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          prompt,
          stream: streamMode,
          options: {
            temperature: 0.5,
          },
        }),
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!ollamaResponse.ok) {
      const errorText = await ollamaResponse.text().catch(() => "");
      console.error("Ollama error response:", ollamaResponse.status, errorText);
      return NextResponse.json(
        { error: `Ollama connection failed (HTTP ${ollamaResponse.status})` },
        { status: 502 },
      );
    }

    const stream = new ReadableStream({
      async start(controller) {
        const reader = ollamaResponse.body?.getReader();
        if (!reader) return controller.close();

        const decoder = new TextDecoder();
        let buffer = "";
        let isDone = false;

        try {
          while (!isDone) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              try {
                const parsed = JSON.parse(trimmed);

                if (parsed.response) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      JSON.stringify({ response: parsed.response }) + "\n",
                    ),
                  );
                }

                if (parsed.done) {
                  isDone = true;
                  break;
                }

                if (parsed.error) {
                  console.error("Ollama stream error:", parsed.error);
                  controller.enqueue(
                    new TextEncoder().encode(
                      JSON.stringify({ error: parsed.error }) + "\n",
                    ),
                  );
                  isDone = true;
                  break;
                }
              } catch {}
            }
          }
        } catch (err: any) {
          if (err?.name !== "AbortError") {
            controller.error(err);
          }
        } finally {
          reader.releaseLock();
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      return new Response(null, { status: 204 });
    }
    console.error("Route Error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
