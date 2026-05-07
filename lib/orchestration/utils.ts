import fs from "fs";
import path from "path";
import { Page } from "playwright";
import { pageLocks } from "./globals";

export function parseJsonFromText(text: string): any {
  if (!text) return null;

  // Find all occurrences of '{' and extract balanced objects
  let results: any[] = [];
  let pos = 0;
  while ((pos = text.indexOf("{", pos)) !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    let endPos = -1;

    for (let i = pos; i < text.length; i++) {
      const char = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === "{") depth++;
        else if (char === "}") {
          depth--;
          if (depth === 0) {
            endPos = i;
            break;
          }
        }
      }
    }

    if (endPos !== -1) {
      const block = text.substring(pos, endPos + 1);
      try {
        const parsed = JSON.parse(block);
        if (parsed && typeof parsed === "object" && parsed.status) {
          results.push(parsed);
        }
      } catch {
        // Not valid JSON or parsing error, skip
      }
      pos = endPos + 1;
    } else {
      pos++;
    }
  }

  // Return the LATEST status update if multiple exist
  return results.length > 0 ? results[results.length - 1] : null;
}

export function fileFingerprint(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return `${content.length}:${content.slice(0, 64)}`;
  } catch {
    return `missing:${filePath}`;
  }
}

export async function lockPage(page: Page, label: string) {
  const currentLock = pageLocks.get(page) || Promise.resolve();
  let resolveLock: () => void;
  const newLock = new Promise<void>((r) => {
    resolveLock = r;
  });

  pageLocks.set(page, newLock);
  await currentLock;

  return () => {
    resolveLock();
    if (pageLocks.get(page) === newLock) {
      pageLocks.delete(page);
    }
  };
}


export function getFuzzyCandidates(filePath: string): string[] {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const candidates = new Set<string>();

  // 1. Hyphen/Underscore swaps (common model misprediction)
  if (base.includes("_") || base.includes("-")) {
    candidates.add(path.join(dir, base.replace(/_/g, "-")));
    candidates.add(path.join(dir, base.replace(/-/g, "_")));
  }

  // 2. Python-specific dunder versions
  if (filePath.endsWith(".py")) {
    candidates.add(path.join(dir, `__${base}`));
    candidates.add(path.join(dir, base.replace(/^__?/, "")));
    if (base === "init.py") candidates.add(path.join(dir, "__init__.py"));
    if (base === "main.py") candidates.add(path.join(dir, "__main__.py"));
  }

  return Array.from(candidates).filter((c) => c !== filePath);
}
