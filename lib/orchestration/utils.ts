import fs from "fs";
import path from "path";
import { Page } from "playwright";
import { pageLocks } from "./globals";

export function parseJsonFromText(text: string): any {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return JSON.parse(text);
  } catch {
    return null;
  }
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

export function writeOpencodeConfig(repoDir: string) {
  const configPath = path.join(repoDir, "opencode.json");
  const config = {
    $schema: "https://opencode.ai/config.json",
    permission: "allow",
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}
