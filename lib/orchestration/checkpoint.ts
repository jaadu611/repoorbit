import fs from "fs";
import path from "path";

export type StepId =
  | "sync"
  | "preflight"
  | "synthesis"
  | "execution"
  | "testing"
  | "diff"
  | "delivery";

export interface CheckpointData {
  version: 2;
  taskId: string;
  owner: string;
  repo: string;
  query: string;
  savedAt: number;
  completedSteps: StepId[];
  // Outputs from each completed step needed by subsequent steps
  repoWorkDir?: string;
  rootManifestContent?: string;
  baselinePassed?: string[];
  baselineFailed?: string[];
  finalAnswer?: string;
  testSummary?: string;
  diffMarkdown?: string;
}

/**
 * Returns the path to the checkpoint file for a given outDir.
 */
function getCheckpointPath(outDir: string): string {
  return path.join(outDir, "checkpoint.json");
}

/**
 * Loads a checkpoint if it exists and is valid for this job.
 */
export function loadCheckpoint(
  outDir: string,
  taskId: string,
  owner: string,
  repo: string,
  query: string,
): CheckpointData | null {
  const checkpointPath = getCheckpointPath(outDir);
  if (!fs.existsSync(checkpointPath)) return null;

  try {
    const raw = fs.readFileSync(checkpointPath, "utf-8");
    const data: CheckpointData = JSON.parse(raw);

    // Validate it matches this exact job
    if (
      data.version !== 2 ||
      data.taskId !== taskId ||
      data.owner !== owner ||
      data.repo !== repo ||
      data.query !== query
    ) {
      console.log("[CHECKPOINT] Stale or mismatched checkpoint — ignoring.");
      return null;
    }

    // Reject checkpoints older than 24 hours
    const ageHours = (Date.now() - data.savedAt) / (1000 * 60 * 60);
    if (ageHours > 24) {
      console.log("[CHECKPOINT] Checkpoint is >24h old — ignoring.");
      return null;
    }

    console.log(
      `[CHECKPOINT] Resuming from step after: ${data.completedSteps.at(-1) ?? "none"}`,
    );
    return data;
  } catch {
    return null;
  }
}

/**
 * Saves checkpoint state after a step completes.
 */
export function saveCheckpoint(
  outDir: string,
  data: Omit<CheckpointData, "version" | "savedAt">,
): CheckpointData {
  const checkpoint: CheckpointData = {
    ...data,
    version: 2,
    savedAt: Date.now(),
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    getCheckpointPath(outDir),
    JSON.stringify(checkpoint, null, 2),
    "utf-8",
  );
  console.log(
    `[CHECKPOINT] Saved after step: ${data.completedSteps.at(-1) ?? "none"}`,
  );
  return checkpoint;
}

/**
 * Deletes the checkpoint file on successful job completion.
 */
export function clearCheckpoint(outDir: string): void {
  const p = getCheckpointPath(outDir);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log("[CHECKPOINT] Cleared on successful completion.");
  }
}

/**
 * Helper: returns true if a step was already completed in this checkpoint.
 */
export function isStepComplete(
  checkpoint: CheckpointData | null,
  stepId: StepId,
): boolean {
  return checkpoint?.completedSteps.includes(stepId) ?? false;
}
