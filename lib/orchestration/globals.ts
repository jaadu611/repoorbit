import { Page } from "playwright";
import { JobStatus } from "@/lib/core/types";

const GLOBAL_JOBS_KEY = Symbol.for("repoorbit.playwright.jobs");
export const activeJobs: Map<string, JobStatus> =
  (global as any)[GLOBAL_JOBS_KEY] || new Map();
(global as any)[GLOBAL_JOBS_KEY] = activeJobs;

const GLOBAL_PAGES_KEY = Symbol.for("repoorbit.playwright.pages");
export interface PersistentPages {
  dsCoder: Page | null;
  qwenCoder: Page | null;
  dsReviewer: Page | null;
  qwenReviewer: Page | null;
  dsSynthesizer: Page | null;
}
export const persistentPages: PersistentPages = (global as any)[GLOBAL_PAGES_KEY] || {
  dsCoder: null,
  qwenCoder: null,
  dsReviewer: null,
  qwenReviewer: null,
  dsSynthesizer: null,
};
(global as any)[GLOBAL_PAGES_KEY] = persistentPages;

export const pageLocks = new Map<Page, Promise<void>>();
