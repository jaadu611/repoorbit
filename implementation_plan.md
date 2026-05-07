# Upgrade Workflow: 3-Agent Parallel Pipeline with Mistral Combiner

This upgrade shifts the orchestration from a dual-model (DeepSeek/Qwen) system to a triple-model parallel system (Kimi, GLM, Minimax) with a specialized combiner (Mistral Medium). It also hardens the sandbox by moving runtime files into the repository root and ensuring models have explicit access to the root manifest.

## User Review Required

> [!IMPORTANT]
> This upgrade requires several new API keys. Ensure the following environment variables are set:
> - `KIMI_API_KEY`
> - `GLM_API_KEY`
> - `MINIMAX_API_KEY`
> - `MISTRAL_API_KEY`
>
> All models will be accessed via OpenAI-compatible endpoints (e.g., Moonshot, Zhipu, MiniMax, and Mistral/NVIDIA).

> [!WARNING]
> This change will remove browser-based automation for DeepSeek and Qwen, transitioning the entire pipeline to high-speed API inference.

## Proposed Changes

### Core Orchestration

#### [MODIFY] [processor.ts](file:///home/jaadu/Github-Projects/repoorbit/lib/orchestration/processor.ts)
- Update `processJob` to create a `/temp` folder within the cloned repository root for runtime files.
- Ensure the `00_Root_Manifest.txt` is copied to the root of the repository clone so models can see exact paths.

#### [MODIFY] [surgery.ts](file:///home/jaadu/Github-Projects/repoorbit/lib/orchestration/surgery.ts)
- Refactor `runInitialSynthesis` to orchestrate three parallel coders: **Kimi-2.6**, **GLM-5.1**, and **Minimax-2.7**.
- Replace `qwenCombine` with a new `mistralCombine` using **Mistral-Medium-3.5-128b**.
- Update the loop logic:
    1. **Parallel Coders**: 3 models generate drafts.
    2. **Synthesis**: Mistral merges drafts into a "Master Plan".
    3. **Parallel Reviewers**: The same 3 models review the Master Plan.
    4. **Feedback Consolidation**: Reviewers write problems/suggestions into a single file in `/temp`.
    5. **Termination**: Loop continues until all reviewers signal "PERFECT".
- Final Architecture Synthesis will also use Mistral-Medium.

### Automation Layer

#### [NEW] [llm.ts](file:///home/jaadu/Github-Projects/repoorbit/lib/automation/llm.ts)
- Create a generic OpenAI-compatible adapter that takes `apiKey`, `baseURL`, and `modelName`.
- This will replace the specialized `deepseek.ts` and `qwen.ts` (for coding logic).

#### [MODIFY] [agents.ts](file:///home/jaadu/Github-Projects/repoorbit/lib/orchestration/agents.ts)
- Update `runSingleModelTurn` to use the new generic `llm.ts` adapter.
- Remove Playwright/browser-locking logic for these agents as they are now purely API-driven.

### Prompts

#### [MODIFY] [prompts/index.ts](file:///home/jaadu/Github-Projects/repoorbit/lib/prompts/index.ts)
- Update prompt templates to reflect the new 3-agent structure and ensure reviewers know how to write to the shared suggestions file.

## Verification Plan

### Automated Tests
- Run the pipeline with a sample issue.
- Verify that `/temp` is created and contains the iteration files.
- Verify that API calls are distributed across the 4 providers (Kimi, GLM, Minimax, Mistral).

### Manual Verification
- Inspect the `/temp/suggestions.txt` file during execution to ensure reviewers are collaborating correctly.
- Verify that the "Final Operator" (Gemma) applies the final synthesized plan correctly to the disk.
