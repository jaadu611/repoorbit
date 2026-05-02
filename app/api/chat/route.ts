import { NextResponse } from "next/server";
import path from "path";
import { activeJobs } from "@/lib/orchestration/globals";
import { CONTEXT_DIR_PATH } from "@/lib/orchestration/constants";
import { processJob } from "@/lib/orchestration/processor";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const taskId = searchParams.get("taskId");
  if (!taskId)
    return NextResponse.json({ error: "Missing taskId" }, { status: 400 });
  return NextResponse.json(activeJobs.get(taskId) || { status: "pending" });
}

export async function POST(req: Request) {
  try {
    const { query, owner, repo, defaultBranch } = await req.json();
    const taskId = Math.random().toString(36).substring(7);
    activeJobs.set(taskId, { status: "pending" });

    const outDir = path.join(CONTEXT_DIR_PATH, owner, repo);
    
    // Fire and forget the background job
    processJob(taskId, query, owner, repo, defaultBranch, outDir).catch((err) => {
      console.error(`[ORCHESTRATOR] Fatal background error for task ${taskId}:`, err);
    });

    return NextResponse.json({ status: "accepted", taskId });
  } catch (error: any) {
    console.error("[API-CHAT] Uncaught Route Error:", error);
    return NextResponse.json(
      { error: error.message, status: "error", details: error.stack },
      { status: 500 },
    );
  }
}
