# RepoOrbit

RepoOrbit is a VS Code extension that orchestrates automated, self-healing contribution pipelines directly inside your editor. It acts as the visual control plane and bridge, communicating with the **Antigravity background agent** running on your system to autonomously resolve tasks, run test pipelines, review diffs, and commit changes.

---

## How It Works

RepoOrbit runs inside your VS Code window and connects with your active system-wide agent:

1. **Background Agent Link**: You run the **Antigravity agent** in the background on your machine.
2. **IDE Integration**: RepoOrbit runs inside VS Code, automatically detecting local repositories and establishing a communication channel with the background agent.
3. **Automated Queue Execution**: RepoOrbit loads target tasks from your workspace, streams query instructions to the background agent, auto-approves tool confirmation steps, and verifies code review results in a closed loop.

```
+------------------------------------------------------+
|                     YOUR IDE                         |
|   +-------------------+      +-------------------+   |
|   |    Local Files    | <--> |     RepoOrbit     |   |
|   +-------------------+      |  (Webview Panel)  |   |
|                                        ^             |
+----------------------------------------|-------------+
                                         |
                                         v
                      +-------------------------------------+
                      |         BACKGROUND SYSTEM           |
                      |   +-----------------------------+   |
                      |   |    Antigravity Agent        |   |
                      |   +-----------------------------+   |
                      +-------------------------------------+
```

---

## Key Features

- **Self-Healing Review Loop**: Iteratively reviews changes using a configurable code review evaluator. If changes score below `4/5`, it auto-generates correction prompts and triggers repairs up to 3 times before committing success states.
- **Hands-Free Auto-Approval**: Features a background confirmation bypass scheduler (`RepoOrbitExecutor`) with a 3-attempt backoff retry loop. It automatically accepts agent tool calls, file edits, and terminal confirmation popups.
- **GitHub Issue & Discussion Extractor**: Fetches and crawls referenced issues, discussions, and linked pull requests via the GitHub CLI or API. It automatically strips comment noise (chatter, "+1" remarks, emojis) to construct noise-free implementation plans.
- **Real-Time Trajectory Inspector**: Renders flat, solid UI status panels displaying active execution steps, agent thinking logs, running tools, and exact JSON parameters in real-time.
- **Workspace Diagnostics**: Automatically validates target clone directories to ensure they are empty, parses file system layouts, extracts file import graphs, and reports stack/dependency configurations.

---

## Setup & Usage

### 1. Run Antigravity in the Background
Ensure your background Antigravity agent process is active on your host machine and ready to accept command executions from the editor context.

### 2. Install the Extension
Search for **RepoOrbit** in the VS Code Extensions View (`Ctrl+Shift+X` / `Cmd+Shift+X`) and click **Install**.

### 3. Configure Your Task Queue
Create a `.repoorbit/queries.md` file in the root of your workspace to define your issue checklist. You can reference specific GitHub issues directly:

```markdown
github-issue: owner/repo#42
---
Fix the responsive layout overflow in the sidebar component.
```

### 4. Run the Pipeline
Open the **RepoOrbit** sidebar tab in the Activity Bar, choose your preferred LLM model, and click **Play**. The extension will coordinate with the background agent to implement and commit the fixes autonomously.
