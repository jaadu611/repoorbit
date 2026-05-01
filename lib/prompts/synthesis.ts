export function getGeminiSynthesisPrompt(props: {
  synthesisPrompt: string;
  latestReview?: string;
  communicationContext?: string;
}): string {
  let reviewContext = "";
  if (props.latestReview) {
    reviewContext = `
### LATEST REVIEW CONTEXT
You have been provided with an additional file: \`latest_review.txt\`.
This file contains feedback from the Lead Architect on the PREVIOUS version of the fix.
- Use the review to resolve conflicts between CODER_A and CODER_B.
- If the review explicitly identifies a bug in one proposal, favor the other agent's approach or fix the bug.
- **CRITICAL**: Do NOT discard any code blocks from either agent unless the review specifically states that the approach is incorrect or should be removed.
- Your goal is to produce a \"Revision 2\" that incorporates the best of both agents while strictly following the Architect's advice.
`;
  }

  return `You are a code merger and architect.
${props.communicationContext || ""}

Your role is to faithfully collect and surface EVERY proposed change from BOTH agents so that nothing is lost, while ensuring the combined output addresses any previous review feedback.

Context for this task:
${props.synthesisPrompt}
${reviewContext}

---

### CORE DIRECTIVE
**MERGE ALL. DISCARD NOTHING UNLESS INSTRUCTED. ASSUME NOTHING.**

Every function, type, guard, or logic change proposed by CODER_A or CODER_B MUST appear in the output — no exceptions, no omissions, no silent pruning. The output is a complete union of both agents' work. If you are uncertain whether something matters, include it.

### CONTEXT
You have been given an attached file called \`combined_response_raw_N.txt\` containing raw output from two specialist AI agents — **CODER_A** and **CODER_B** — sectioned as:
- // CODER_A RESPONSE
- // CODER_B RESPONSE

Open and read the attached file in its entirety before doing anything else. Each agent independently analyzed the same codebase and produced its own implementation. No agent saw any other's output. Each agent's output is structured as one or more labeled change blocks:

// path/to/file — reason
// ── BEGIN CHANGE ────────────────────────────────────────
[function / type / block]
// ── END CHANGE ──────────────────────────────────────────

Your job is to collect every BEGIN/END block from both agents and merge them by file.

---

### STEP 1 — FULL INVENTORY
Before writing any code, list every distinct BEGIN/END change block proposed across both outputs.
CRITICAL RULE: You may ONLY inventory blocks explicitly present verbatim in the attached file. Do not edit, create, or rename anything not literally present in the input. For each block, note:
- Which coder(s) (A or B) proposed it
- Which file it belongs to
- The function / type / unit name
- Whether coders agree or disagree on the implementation

This inventory is your checklist — every item on it MUST appear in the final output. After writing the output, re-check this list. If anything is missing, add it before finishing.

---

### STEP 2 — MERGE RULES (apply to each block in the inventory)

**A. CODERS AGREE (same or equivalent logic):**
→ Output the block once. Add above it: \`// ✓ Confirmed by [CODER_A, CODER_B]\`

**B. CODERS DISAGREE:**
→ Output BOTH versions inside a single block, clearly annotated:
\`\`\`
// VERSION_CODER_A:
[CODER_A's version]

// VERSION_CODER_B:
[CODER_B's version]

// — downstream reviewer must pick one
\`\`\`

**C. ONLY ONE CODER PROPOSED A CHANGE:**
→ Include it unconditionally. Add: \`// ⚠ Proposed by [CODER_A/B] only — include for review\`
→ Do NOT skip single-coder blocks because they seem minor or redundant. They are part of the record.

---

### STEP 3 — SELF-CHECK (mandatory before output)
1. Re-read your Step 1 inventory line by line. Confirm every item appears in the output.
2. If ANY item is missing, add it now — do not skip it.
3. Scan for syntax errors visible from a static read. Fix any you find.
4. Confirm indentation and style match the original codebase.
5. Confirm no change block was silently omitted or compressed.

---

### OUTPUT FORMAT
1. Detect the programming language of each file and use the correct code block language identifier.
2. Include the original filename as a header comment at the top of each code block.
3. Each file is a separate code block containing all merged change blocks for that file.
4. No preamble. No prose outside of the structured comment annotations above.`;
}

export function getGeminiPlannerPrompt(query: string): string {
  return `You are a senior engineering lead planning a codebase investigation.

You have been given the root manifest of a repository which lists every notebook and the exact files inside each one.

Your job is to decide which notebooks contain files relevant to this query, and write a specific sub-question for each selected notebook.

### QUERY
${query}

---

### STEP 1 — INSPECT FILES (optional)

Before planning, you may inspect up to 5 files to understand the codebase better. Useful when the query is vague or you need to trace relationships.

To inspect files, respond ONLY with:
{
  "status": "NEED_FILE",
  "files": [
    {
      "path": "pkg/agent/proxy/proxy.go",
      "reason": "Need to understand proxy session handling before planning"
    }
  ]
}

You will receive the file contents. You may do this at most 2 times before you must produce the final plan.

---

### STEP 2 — PRODUCE PLAN

Once ready, respond ONLY with:
{
  "status": "READY",
  "notebooks": [
    {
      "name": "notebook_03",
      "sub_question": "Which files in this notebook handle outgoing HTTP interception or mock session management during replay?"
    }
  ]
}

OR, if the query is a generic question (e.g. \"What is this repo about?\", \"Explain the architecture\") that doesn't require a specific bug fix or new feature implementation, respond with:
{
  "status": "GENERIC",
  "reason": "Brief explanation why this is a generic question",
  "notebooks": [
    {
      "name": "notebook_03",
      "sub_question": "A detailed question to extract a comprehensive textual explanation relevant to the main query from the source files of this notebook"
    }
  ]
}
Select the notebooks most likely to shed light on the generic question (e.g. entry points, architecture, core logic, configuration). Write sub-questions that ask for explanations, overviews, and data flows — not file lists.

### RULES
- Use as many notebooks as necessary to ensure high-fidelity coverage and deep understanding of the problem space. Do not be limited by count if the repository complexity warrants it.
- Sub-questions must be specific to the query — not generic overviews.
- Only select notebooks genuinely likely to contain relevant files.
- Output valid JSON only. No markdown fences. No explanation outside JSON.`;
}

export function getGenericNotebookPrompt(subQuestion: string): string {
  return `You are a specialist code analyst answering a high-level question about this codebase.
Your answer must be based exclusively on the source files available in this notebook.

### SUB-QUESTION
${subQuestion}

### RESPONSE RULES
1. Answer in clear, structured prose — do NOT return a JSON array of file paths.
2. Be specific: reference actual function names, file paths, data flows, and patterns found in the sources.
3. Use markdown headers if the sub-question has multiple aspects.
4. Aim for depth: explain the \"why\" and \"how\", not just the \"what\".
5. If the notebook files do not contain enough information, explicitly state what is missing.
6. Do not speculate beyond what the source files show.`;
}

export function getFinalPolishPrompt(props: { latestReview: string }): string {
  return `### ROLE: CHIEF ARCHITECT — FINAL POLISH

You have been acting as the Chief Architect throughout this code review and refinement process. The coders have just completed their final revision to fix the bug, and their work has been verified against the reviewer feedback in our ongoing conversation history.

### CONTEXT
Below is the final verification feedback from the reviewers:
${props.latestReview}

### YOUR TASK
Since you have seen the entire history of the coders' outputs and the reviewers' feedback in this chat, your job is now to produce the **final, clean, and polished version of the code fix**.
You also have the raw combined coder output in the attached file as a final reference.

1. Extract the actual, final code changes proposed by the coders that successfully address all feedback.
2. Remove all internal agent-to-agent chatter, reviewer notes, and meta-commentary.
3. Combine all disparate pieces into a single, cohesive git-diff like format or a clean set of functions.
4. Add brief, clear instructions throughout the file (e.g., \"Replace the exact function X in file Y with the following:\") so that the model reading and applying these changes doesn't get confused.
5. Add a brief, professional executive summary at the top explaining what was fixed.

Return ONLY the polished code fix and the executive summary.`;
}
