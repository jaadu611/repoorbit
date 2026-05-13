import { exec as execRaw } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { askNvidia, DEFAULT_MODEL } from "@/lib/automation/llm";
import { OPENCODE_MODEL_ID } from "@/lib/automation/opencode";
import { parseJsonFromText } from "./utils";

const exec = promisify(execRaw);

export interface TestResult {
  name: string;
  passed: boolean;
  output: string;
  duration: number;
}

export interface TestSuiteResult {
  allPassed: boolean;
  results: TestResult[];
  summary: string;
  aiDiagnosis?: string;
}

async function runCheck(
  name: string,
  command: string,
  cwd: string,
): Promise<TestResult> {
  const start = Date.now();
  try {
    const { stdout, stderr } = await exec(command, {
      cwd,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, CI: "true", NODE_ENV: "test" },
    });
    return {
      name,
      passed: true,
      output: (stdout + stderr).trim().slice(0, 2000),
      duration: Date.now() - start,
    };
  } catch (err: any) {
    return {
      name,
      passed: false,
      output: (err.stdout + err.stderr + err.message).trim().slice(0, 3000),
      duration: Date.now() - start,
    };
  } finally {
    // Cleanup Playwright/Chromium temp profiles to prevent disk bloat
    try {
      const { execSync } = require("child_process");
      execSync("find /tmp -maxdepth 1 -name 'playwright_*' -mmin +1 -exec rm -rf {} + 2>/dev/null || true");
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Detects which checks are viable for this repo and runs them all.
 * Returns a consolidated report.
 */
export async function runTestSuite(
  repoWorkDir: string,
  onStatus: (msg: string) => void,
): Promise<TestSuiteResult> {
  const pkg = path.join(repoWorkDir, "package.json");
  const hasPkg = fs.existsSync(pkg);
  const pkgJson = hasPkg ? JSON.parse(fs.readFileSync(pkg, "utf-8")) : {};
  const scripts = pkgJson.scripts || {};
  const hasTsConfig = fs.existsSync(path.join(repoWorkDir, "tsconfig.json"));
  const hasEslint =
    fs.existsSync(path.join(repoWorkDir, ".eslintrc.js")) ||
    fs.existsSync(path.join(repoWorkDir, ".eslintrc.json")) ||
    fs.existsSync(path.join(repoWorkDir, ".eslintrc.cjs")) ||
    !!pkgJson.eslintConfig;
  const hasBiome = fs.existsSync(path.join(repoWorkDir, "biome.json"));

  const results: TestResult[] = [];

  // 1. TypeScript type-check
  if (hasTsConfig) {
    onStatus("Tests — Running TypeScript type-check...");
    results.push(
      await runCheck(
        "TypeScript (tsc)",
        "npx tsc --noEmit --skipLibCheck",
        repoWorkDir,
      ),
    );
  }

  // 2. ESLint
  if (hasEslint) {
    onStatus("Tests — Running ESLint...");
    results.push(
      await runCheck(
        "ESLint",
        "npx eslint . --ext .ts,.tsx,.js,.jsx --max-warnings=0 --no-error-on-unmatched-pattern",
        repoWorkDir,
      ),
    );
  }

  // 3. Biome (if present — modern replacement for ESLint)
  if (hasBiome) {
    onStatus("Tests — Running Biome lint+check...");
    results.push(
      await runCheck("Biome", "npx biome check .", repoWorkDir),
    );
  }

  // 4. Unit tests (vitest, jest, or npm test)
  if (scripts.test && !scripts.test.includes("echo")) {
    const testCmd =
      scripts.test.includes("vitest") || scripts["test:unit"]
        ? "npx vitest run --reporter=verbose"
        : "npm test -- --passWithNoTests 2>&1";
    onStatus("Tests — Running unit tests...");
    results.push(await runCheck("Unit Tests", testCmd, repoWorkDir));
  }

  // 5. Build check — catches dead imports, missing modules, bundler errors
  if (scripts.build) {
    onStatus("Tests — Running build check...");
    results.push(
      await runCheck(
        "Build Check",
        "npm run build 2>&1 | tail -50",
        repoWorkDir,
      ),
    );
  }

  // 6. Dead / unreachable code scan via ts-prune
  if (hasTsConfig) {
    onStatus("Tests — Scanning for dead/unreachable code...");
    results.push(
      await runCheck(
        "Dead Code (ts-prune)",
        "npx ts-prune --error 2>&1 | grep -v 'node_modules' | head -40 || true",
        repoWorkDir,
      ),
    );
  }

  // 7. E2E tests (Playwright)
  const hasPlaywright = fs.existsSync(path.join(repoWorkDir, "playwright.config.ts")) ||
    fs.existsSync(path.join(repoWorkDir, "playwright.config.js"));
  if (hasPlaywright) {
    onStatus("Tests — Running Playwright E2E tests...");
    results.push(
      await runCheck(
        "E2E Tests (Playwright)",
        "npx playwright test --reporter=list 2>&1 | tail -40",
        repoWorkDir,
      ),
    );
  }

  // 8. E2E tests (Cypress fallback)
  const hasCypress = fs.existsSync(path.join(repoWorkDir, "cypress.config.ts")) ||
    fs.existsSync(path.join(repoWorkDir, "cypress.config.js")) ||
    fs.existsSync(path.join(repoWorkDir, "cypress.json"));
  if (hasCypress && !hasPlaywright) {
    onStatus("Tests — Running Cypress E2E tests...");
    results.push(
      await runCheck(
        "E2E Tests (Cypress)",
        "npx cypress run --headless 2>&1 | tail -40",
        repoWorkDir,
      ),
    );
  }

  // 9. Security scan
  if (hasPkg) {
    onStatus("Tests — Running security audit (npm audit)...");
    results.push(
      await runCheck(
        "Security (npm audit)",
        "npm audit --audit-level=high --json 2>&1 | npx -y node -e \"const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));const v=d.metadata?.vulnerabilities||{};const h=(v.high||0)+(v.critical||0);console.log(h===0?'✓ No high/critical vulnerabilities':'✗ '+h+' high/critical vulnerabilities found');if(h>0)process.exit(1)\" || npm audit --audit-level=high 2>&1 | tail -20",
        repoWorkDir,
      ),
    );
  }

  const failedResults = results.filter((r) => !r.passed);
  const allPassed = failedResults.length === 0;

  const summary = results
    .map((r) => `${r.passed ? "✓" : "✗"} ${r.name} (${r.duration}ms)`)
    .join("\n");

  let aiDiagnosis: string | undefined;

  // If any checks failed, ask the AI to diagnose and suggest fixes
  if (!allPassed) {
    const failReport = failedResults
      .map((r) => `### ${r.name} FAILED\n\`\`\`\n${r.output}\n\`\`\``)
      .join("\n\n");

    const diagPrompt = `### ROLE: SENIOR DEBUGGING ENGINEER

The following automated checks failed after applying code changes to a repository.
Analyze each failure and provide CONCRETE, ACTIONABLE fixes.

${failReport}

### OUTPUT FORMAT (JSON only):
{
  "root_causes": ["cause 1", "cause 2"],
  "fixes": [
    { "file": "path/to/file.ts", "issue": "description", "fix": "exact change needed" }
  ],
  "verdict": "Brief overall assessment"
}`;

    try {
      const diagResponse = await askNvidia(
        DEFAULT_MODEL,
        [{ role: "user", content: diagPrompt }],
        onStatus,
        "[TEST-DIAG]",
        3,
      );
      const parsed = parseJsonFromText(diagResponse);
      aiDiagnosis = parsed
        ? JSON.stringify(parsed, null, 2)
        : diagResponse.slice(0, 1500);
    } catch (e) {
      aiDiagnosis = "AI diagnosis unavailable.";
    }
  }

  return { allPassed, results, summary, aiDiagnosis };
}

/**
 * Uses OpenCode to apply AI-diagnosed fixes, then re-runs the test suite.
 * Repeats until all tests pass or max attempts are exhausted.
 */
export async function runTestFixLoop(
  repoWorkDir: string,
  initialResult: TestSuiteResult,
  outDir: string,
  onStatus: (msg: string) => void,
  updateAgent: (agent: any) => void,
  maxAttempts: number = 3,
): Promise<TestSuiteResult> {
  const { ensureOpenCodeServer, createSession, sendToOpenCode } = await import(
    "@/lib/automation/opencode"
  );

  let currentResult = initialResult;
  const OPENCODE_PORT = 3001;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (currentResult.allPassed) break;

    onStatus(
      `Tests — Auto-fixing failures (Attempt ${attempt + 1}/${maxAttempts})...`,
    );
    updateAgent({
      id: "test_fixer",
      name: "Test Fixer",
      model: OPENCODE_MODEL_ID,
      status: "thinking",
      lastMsg: `Fixing test failures (attempt ${attempt + 1})...`,
    });

    const failedNames = currentResult.results
      .filter((r) => !r.passed)
      .map((r) => r.name)
      .join(", ");

    const fixPrompt = `### ROLE: DEBUGGING ENGINEER
The following automated checks are failing in this repository:

## Failing Checks
${failedNames}

## AI Diagnosis
${currentResult.aiDiagnosis || "No AI diagnosis available."}

## Detailed Failure Output
${currentResult.results
  .filter((r) => !r.passed)
  .map((r) => `### ${r.name}\n\`\`\`\n${r.output}\n\`\`\``)
  .join("\n\n")}

### YOUR TASK
Fix ALL the above failures. You are an autonomous agent with FULL access to the repo. Do NOT just give me instructions — use your 'edit', 'write', and 'bash' tools to apply the fixes directly.
- Fix TypeScript errors, ESLint violations, dead imports, broken builds.
- DO NOT introduce new issues while fixing existing ones.
- After applying fixes, verify each changed file looks correct by re-reading it.
- When finished, you MUST respond with a text message starting with "DONE: [summary of what was fixed]". Do NOT just exit the session.`;

    try {
      const sessionId = await createSession(OPENCODE_PORT, repoWorkDir);
      await sendToOpenCode(OPENCODE_PORT, sessionId, fixPrompt);
    } catch (e: any) {
      onStatus(`Test fix attempt ${attempt + 1} failed: ${e.message}`);
    }

    // Re-run the test suite
    onStatus(`Tests — Re-running checks after fix attempt ${attempt + 1}...`);
    currentResult = await runTestSuite(repoWorkDir, onStatus);
    fs.writeFileSync(
      path.join(outDir, `test_result_attempt_${attempt + 1}.json`),
      JSON.stringify(currentResult, null, 2),
      "utf-8",
    );
  }

  updateAgent({
    id: "test_fixer",
    name: "Test Fixer",
    model: OPENCODE_MODEL_ID,
    status: currentResult.allPassed ? "done" : "error",
    lastMsg: currentResult.allPassed
      ? "All tests passing ✓"
      : `${currentResult.results.filter((r) => !r.passed).length} check(s) still failing`,
  });

  return currentResult;
}
