export function getReviewerPrompt({
  userQuery,
  gitDiff,
  passNumber,
  previousFeedback,
}: {
  userQuery: string;
  gitDiff: string;
  passNumber: number;
  previousFeedback?: string;
}) {
  let prompt = `### ROLE: SENIOR SECURITY & QUALITY REVIEWER
You are a zero-trust reviewer. Your task is to audit the following git diff against the user's goal.

### USER GOAL
${userQuery}

### GIT DIFF (CHANGES TO REVIEW)
${gitDiff}

`;

  if (previousFeedback) {
    prompt += `### PREVIOUS ISSUES (STILL PENDING)
${previousFeedback}

`;
  }

  prompt += `### REVIEW PROTOCOL
1. TRACE: Use 'grep' to find all callers and importers of the changed files.
2. VERIFY: Read the affected files to ensure the logic still holds (check for dead imports, broken paths, or logic regressions).
3. VERDICT: Output a JSON verdict with this EXACT format (use single braces for keys):
{
  "has_issues": true/false,
  "feedback": "detailed analysis of what is wrong",
  "suggestions": "exact steps for the coder to fix it"
}

### CRITICAL RULES
- ZERO TRUST: Do not assume the code works. Verify it with your tools.
- NO FALSE APPROVALS: If any file was missed or if there's a risk of regression, reject it.
- JSON ONLY AT THE END: Your final output must be the JSON block.
`;

  return prompt;
}
