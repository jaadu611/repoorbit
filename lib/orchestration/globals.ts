import { JobStatus } from "@/lib/core/types";

const GLOBAL_JOBS_KEY = Symbol.for("repoorbit.playwright.jobs");
export const activeJobs: Map<string, JobStatus> =
  (global as any)[GLOBAL_JOBS_KEY] || new Map();
(global as any)[GLOBAL_JOBS_KEY] = activeJobs;

// Browser-related state removed as we have transitioned to 100% API-driven orchestration.
