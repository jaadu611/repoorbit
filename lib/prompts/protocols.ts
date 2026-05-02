export const AGENT_COMMUNICATION_PROTOCOL = (
  role: string,
  questionsLeft: number,
) => `
### AGENT-TO-AGENT COMMUNICATION (QUOTA: ${questionsLeft})
> [!IMPORTANT]
> **DOWNTIME NOTICE**: Coders and reviewers are currently OFFLINE and unavailable for queries. 
> You cannot ask any questions to other agents at this time. Please proceed with your task using ONLY the provided code and context.

- **Roles**: coder_a, coder_b, reviewer_a, reviewer_b, architect (Lead Synthesis)
- **Your Role**: ${role}
- **Constraints**: 
  1. This is for **Technical Q&A only**. Do NOT use this for social chatter or casual "conversations".
  2. Focus on broad architectural alignment or specific follow-ups.
  3. Keep exchanges concise. Each question consumes your quota.

If you need to ask another agent a question, respond with ONLY this JSON:
{
  "status": "AGENT_QUERY",
  "to": "[target_role]",
  "from": "${role}",
  "type": "question",
  "question": "your technical inquiry",
  "context": "relevant code/file context"
}

The orchestrator will provide the reply as a context file. Use this sparingly to resolve fundamental disagreements.
`;

export function getNotebookSystemInstruction(): string {
  return `You are a specialist code analyzer. Your task is to identify specific file paths in this notebook that are directly relevant to a sub-question.

RULES:
1. Return ONLY a JSON array of file paths.
2. Example output: ["pkg/service/replay/replay.go", "pkg/agent/proxy/proxy.go"]
3. If no files are relevant, return an empty array: []
4. CONTEXTUAL BREADTH: Do not be too narrow. If a file is relevant, also consider its immediate surroundings, callers, or related logic units in the same notebook that provide necessary context for a deep understanding or a potential fix.
5. TRACING AUTHORITY: If the sub-question involves a data flow or an error, include all files in this notebook that participate in that specific chain (e.g., transport layers, mappers, or stateful handlers).
6. SYMBOL RESOLUTION: If you identify a symbol definition that is critical to the sub-question but the implementation is in another file *within this same notebook*, you MUST include that file.
7. MAX COVERAGE: Prefer including 3-5 relevant files over a single "best" file. Comprehensive context is prioritized over brevity.
8. Output valid JSON only.
9. No explanation. No markdown fences. No preamble.`;
}

export function getNotebookSubQuestionPrompt(subQuestion: string): string {
  return `IMPORTANT: Refer to the rules in notebook_instructions.txt. 
  
Sub-Question: ${subQuestion}

REQUIRED OUTPUT FORMAT: Return ONLY a JSON array of specific file paths (string[]) from this notebook that are relevant to the sub-question. No explanation. No markdown fences. Example: ["dir/file1.go", "dir/file2.go"]`;
}
