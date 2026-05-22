export const WORKFLOWS_FALLBACKS: Record<string, string> = {
  "apply-fix.md": `---
name: Apply Fix
description: Apply surgical, style-compliant fixes to address identified bugs across any language or framework.
---

# Apply Fix Workflow

This workflow guides the implementation of surgical, safe, and style-compliant code modifications.

## 1. Pre-Fix Context Analysis
- Review the targeted files and target lines carefully.
- Read at least 100 lines of context above and below the modification areas to understand scoping, state management, and control flow.
- Identify the project's design conventions (e.g., Tab vs. Space indentation, variable casing, async patterns, logging architecture).

## 2. Dependency & Compatibility Control
- Ensure no unsolicited dependencies are introduced. Prefer clean, native/standard libraries.
- If a dependency is absolutely required, verify compatibility and register it using the project's native package manager (\`npm\`, \`cargo\`, \`pip\`, \`go get\`).

## 3. Implementation Planning & Test-Driven Development (TDD)
- Draft the minimal, most surgical change required to address the bug or feature.
- Ensure the fix handles edge cases (e.g., null checking, array bounds, invalid types, empty values).
- If appropriate for the project, follow the Test-Driven Development cycle (write a failing test first, then implement the minimal fix, then refactor).

## 4. Code Modification Execution
- Apply changes using precise file editing tools (\`replace_file_content\`, \`multi_replace_file_content\`).
- Preserve all unrelated comments, JSDocs, and docstrings.
- Clean up any temporary or debug code before marking the edit complete.

## 5. Leverage Specialist Skills
Utilize these specialized skills to ensure implementation quality:
- **\`test-driven-development\` & \`tdd-workflow\`:** Drive code modifications using red-green-refactor cycles.
- **\`backend-architect\` & \`api-patterns\`:** Adhere to robust, type-safe API patterns and structure.
- **\`react-patterns\` & \`zustand-store-ts\`:** Implement clean state updates and React component patterns.
- **\`ui-component\` & \`ui-pattern\`:** Construct modular, responsive, and accessible user interface components.
- **\`simplify-code\`:** Review diffs for unnecessary complexity and apply safe refactoring simplifications.
- **\`database-design\`:** Write clean, optimized schemas, indexes, and database queries.
`,
  "locate-bug.md": `---
name: Locate Bug
description: Analyze issue reports (stack traces, logs, steps to replicate) and pinpoint the exact source files and buggy lines across any language or framework.
---

# Locate Bug Workflow

This workflow guides the systematic analysis, reproduction, and isolation of bugs or issue root causes in the codebase.

## 1. Diagnostic Context Harvesting
- Analyze the user's issue report, stack traces, logs, or error codes.
- Identify the affected entry points, routes, background tasks, or UI components.
- Locate the main tech stack configuration files (e.g., \`package.json\`, \`Cargo.toml\`, \`go.mod\`, \`requirements.txt\`).

## 2. Hypothesis Generation
- Formulate ranked hypotheses on what is causing the failure (e.g., race condition, database connection pool exhaustion, null reference, routing mismatch, timing unsafe validation).
- Do not jump to coding fixes immediately; prioritize isolating the error space.

## 3. Systematic Workspace Search
- Search the workspace using surgical tools like \`grep_search\` and \`list_dir\` for exact error messages, stack trace symbols, or unique string tokens.
- Locate the exact files and lines mentioned in stack traces.

## 4. Execution Path Tracing
- Trace the control flow backward from the point of failure (sink) to the source input.
- Check state mutations, variable transformations, and API boundaries.
- Cross-reference with the surrounding logic to find where execution deviates from the expected path.

## 5. Leverage Specialist Skills
Utilize the following specialized skills to diagnostic bugs:
- **\`systematic-debugging\`:** Apply logical deduction to isolate variables and narrow down the bug.
- **\`debugger\` & \`gdb-cli\`:** Inspect stack frames, trace executions, or debug core dumps to identify crash origins.
- **\`vibe-code-auditor\`:** Audit rapidly generated or AI-produced code blocks for structural fragility or logic flaws.
- **\`error-debugging-multi-agent-review\` & \`error-diagnostics-smart-debug\`:** Cross-verify complex stack traces or error logs to diagnose systemic runtime issues.

## 6. Root Cause Isolation
- Pinpoint the exact file(s) and line number(s) responsible for the bug.
- Formulate a clear, logical explanation of why the bug occurs. Once isolated, proceed to the Apply Fix workflow.
`,
  "pre-review.md": `---
name: Pre-review
description: Simulate an exceptionally harsh and pedantic AI code review to catch security issues, edge cases, fragile logic, design smells, and style inconsistencies before staging commits.
---

# Pre-review Workflow

This workflow simulates a pedantic, zero-tolerance code reviewer to catch hidden bugs, security vulnerabilities, code smells, and regression risks right before committing changes.

## 1. Diff Extraction & Context Loading
- Extract the complete unified diff of the staged and unstaged changes (e.g., using \`git diff HEAD\`).
- Include any newly added or untracked files intended for the commit.
- Read at least 50 lines above and below all modified hunks to understand contextual dependencies.

## 2. Mandatory Analysis Checklist
Analyze the code against the following rigorous, zero-tolerance criteria:

### A. Security & Integrity (Extreme Rigor)
- **Vulnerabilities:** Check for SQL/NoSQL injection, Command Injection, XSS, Path Traversal, and SSRF.
- **Crypto & Randomness:** Ensure no use of insecure random generators (like raw \`Math.random()\` or insecure seeding) for security-sensitive tokens, passwords, or IDs.
- **Secrets Management:** Ensure no hardcoded passwords, tokens, API keys, private keys, or credentials are introduced in code, configuration files, or templates.
- **Auth & Permissions:** Validate that all modified routes, API endpoints, or services have proper authorization and authentication checks.
- **Comparison/Validation:** Ensure webhook signature validations use constant-time comparisons (e.g., \`crypto.timingSafeEqual\`) to prevent timing attacks.

### B. Error Handling & Logic Gaps (Fragility Check)
- **Swallowed Exceptions:** Catch all potential throw points. Empty \`catch\` blocks or raw ignored rejections are forbidden.
- **Null & Undefined Safety:** Ensure optional chaining (\`?.\`), nullish coalescing (\`??\`), or explicit type guards protect against crash-inducing dereferencing.
- **Resource Leaks:** Ensure all opened sockets, streams, database connections, event listeners, and timers are correctly closed, destroyed, or disposed of.
- **Edge Cases:** Audit loop boundaries, array out-of-bounds index calculations, date-time timezone offsets, and empty input handling.

### C. Architecture & Design Smells
- **Tight Coupling:** Do the changes introduce cyclic dependencies or break encapsulation boundaries?
- **DRY Principle:** Are there cloned/duplicated blocks of logic or copy-pasted utility wrappers that should be extracted?
- **Future Proofing:** Are magic numbers, hardcoded URLs, or environment-specific values used instead of configuration constants or variables?

### D. Performance & Observability
- **N+1 Queries:** Check if database transactions inside loops or map queries are introduced.
- **Costly Computations:** Ensure heavy tasks are not executed synchronously on the main thread or inside render/hot paths.
- **Instrumentation:** Ensure meaningful logging or metrics are present for critical operations, without leaking PII (Personally Identifiable Information).

### E. Code Hygiene & Aesthetics
- **Dead Code:** Check for unused imports, unreachable code blocks, commented-out code, and lingering placeholder values.
- **Leftover Debugging:** Search for console logs, prints, debugger statements, or temporary test scripts.
- **Formatting:** Adhere strictly to the project's formatting tools (Prettier, Biome, ESLint). Fix all linting warnings.

## 3. Leverage Specialist Skills
To perform this review effectively, you must invoke the following specialized instructions:
- **\`code-reviewer\`:** Run a general elite code analysis on the diff to highlight architectural flaws.
- **\`brooks-lint\`:** Check the changes for classic design smells, high coupling, or patterns violating clean architecture.
- **\`vibe-code-auditor\`:** Assess if the generated code is fragile, complex, or contains AI hallucinations.
- **\`security-auditor\` & \`differential-review\`:** Audit changes surgically for common CVE patterns, security weaknesses, and authentication flaws.
- **\`ui-review\`:** (If frontend UI code is modified) Evaluate design system token compliance, accessibility (WCAG), and responsive layouts.
- **\`testing-qa\`:** Verify that test coverage is present for newly added paths.

## 4. Instant Remediation
- Do not generate any feedback reports, tables, or notes for the user.
- If you find any issues, vulnerabilities, code smells, or bugs worth fixing, apply the surgical fixes directly and immediately to the affected files.
- Rerun tests or compilation checks to verify the fixes are stable.
`,
  "run-verification.md": `---
name: Run Verification
description: Dynamically discover and execute linters, compilers, and test suites to verify fix correctness and prevent regressions across any language or framework.
---

# Run Verification Workflow

This workflow ensures code changes are functionally correct, type-safe, performance-compliant, and free of regressions.

## 1. Toolchain & Command Discovery
- Scan the workspace to identify the exact tech stack and build configuration files (e.g., \`package.json\`, \`Cargo.toml\`, \`go.mod\`, \`pom.xml\`, \`requirements.txt\`).
- Identify the standard commands for linting, type-checking, compiling, running tests, and starting local development servers.

## 2. Compile & Type Verification
- Execute compilation or type-checking commands (e.g., \`tsc\`, \`npm run build\`, \`cargo check\`, \`go build\`).
- Verify that there are zero compilation errors and zero new compiler warnings.

## 3. Strict Linter & Style Enforcement
- Run the project's native linter and formatter (e.g., \`eslint\`, \`biome lint\`, \`flake8\`, \`golangci-lint\`, \`prettier\`).
- Resolve all syntax warnings and style violations introduced by the changes. Introducing new linter warnings is considered a failure.

## 4. Test Suite Execution
- **Unit & Integration Tests:** Run tests relevant to the modified files first. If they pass, execute the full test suite (e.g., \`jest\`, \`vitest\`, \`pytest\`, \`cargo test\`, \`go test\`).
- **E2E & UI Verification:** If visual, route, or interactive flow changes were made, run E2E test suites (e.g., \`playwright\`, \`cypress\`).
- **Verify exit code \`0\`:** Ensure every command exits successfully without errors.

## 5. Leverage Specialist Skills
When running verification or debugging errors, invoke these specialized skills:
- **\`testing-qa\`:** Orchestrate comprehensive testing strategies (unit, integration, regression).
- **\`e2e-testing\` & \`webapp-testing\`:** Run/write browser automation tests using Playwright to verify user interface functionality.
- **\`systematic-debugging\` & \`debugger\`:** If any check fails, run diagnostics to systematically narrow down the regression before trying another fix.

## 6. Post-Verification Action
- If all checks pass with exit code \`0\`, proceed to Pre-review or staging/commit.
- If any check fails, immediately route back to Locate Bug / Apply Fix workflows to resolve the issue.
`,
};
