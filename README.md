# RepoOrbit

RepoOrbit is a VS Code extension and unified React Webview-based orchestration interface designed for running automated, self-healing code contribution and query pipelines directly within local workspaces.

It automates the lifecycle of open-source contribution and issue resolution, executing query queues, auto-evaluating resulting code diffs, programmatically bypassing agent confirmation prompts, and committing success states.

---

## Core Features

### 1. Automated Query & Contribution Queue
- **Batch Processing**: Parses and processes a queue of contribution goals or tasks defined in `.repoorbit/queries.md`.
- **Persistent Progress**: Tracks the active execution index and execution states across session reloads, workspace changes, and sidebar toggles.
- **Dynamic Context Building**: Automatically builds query prompts containing custom coding guidelines and environment rules.

### 2. Closed-Loop Self-Healing
- **Automated Code Review**: Captures uncommitted diffs (`git diff HEAD`) and requests an evaluator backend to rate the changes (1 to 5) and provide feedback.
- **Healing Iteration**: If the review rating is below `4`, RepoOrbit automatically formulates a detailed repair query with the feedback and invokes the model again.
- **Autonomous Resolution**: Attempts up to 3 repair cycles. Upon reaching a score of `4+` (or exhausting the attempts limit), changes are staged and committed (`git add -A && git commit`) before progressing to the next task in the queue.

### 3. Programmatic Auto-Approval & Bypass
- **Hands-Free Execution**: Automatically clicks, bypasses, and confirms agent steps, terminal executions, tool calls, and workspace edits.
- **Command Broadcast**: Dispatches programmatic acceptance commands such as `antigravity.acceptAgentStep`, `chatEditing.acceptAllFiles`, and `inlineChat.acceptChanges`.
- **Fault-Tolerant Retry Loop**: Uses Map-based tracking and a 3-attempt backoff (at 5-second intervals) to ensure approval actions succeed even if the UI/agent panel is temporarily unfocused or busy.

### 4. GitHub Issue & Discussion Synthesis
- **Deep Referencing**: Resolves issue references (e.g. `github-issue: owner/repo#issue`) using the GitHub CLI (`gh issue view`) or GitHub API.
- **Smart Noise Filtering**: Automatically filters out conversational noise, duplicate complaints, meta-chatter, emojis, and "+1" reactions from comments.
- **Requirement Mapping**: Isolates exact reproduction steps, error logs, and technical design agreements, compelling the agent to write a structured, clean `implementation_plan.md` mapping issue requirements to code changes.

### 5. Workspace Safety & Diagnostics
- **Target Empty-Check**: Verifies directory emptiness before cloning repositories to prevent file conflicts and git errors.
- **Static Code Inspector**: Recursively maps codebase trees, analyzes file sizes, calculates comment/code lines, extracts import dependencies, and builds dynamic visual graphs of package stacks (Node.js, Next.js, Vite, etc.).
- **Automatic Rule Bootstrapping**: Generates default `.repoorbit/queries.md` files and `.agents/rules/MASTER.md` constitution rules when cloning to guarantee compliance with agentic protocols.

### 6. Premium Flat UI/UX
- **Solid Aesthetic**: Clean, distraction-free visual theme with zero gradients, glowing elements, or unnecessary animations.
- **Real-Time Trajectory Viewer**: Displays current agent thinking logs, active tool names, execution parameters, and live status states (Done, Running, Waiting, Error) step-by-step.
- **Model Vendor Controls**: Easy selection of Gemini, Claude, and GPT models coupled with live usage indicators.

---

## Architectural Layout

The application is structured into a clean host-client model:
- **Extension Host (`src/extension.ts`)**: Manages file system operations, local workspace analysis, Git operations, webview communication, and LLM code review pipelines.
- **Client Frontend (`src/components/WorkspaceLayout.tsx`)**: React UI that coordinates user options, displays visual progress, renders trajectory steps, and feeds query flows back to the extension host.

---

## Getting Started

### 1. Installation
Install the VSIX package directly inside VS Code:
```bash
code --install-extension repoorbit-1.0.0.vsix
```

### 2. Configuration
Define your task queue in the root directory under `.repoorbit/queries.md`:
```markdown
github-issue: owner/repo#12
---
Fix the layout rendering bug on the dashboard panel. Ensure it handles window resizes.
```

### 3. Execution
Open the RepoOrbit Activity Bar icon, choose your model, and press **Play** to start the fully automated self-healing pipeline.
