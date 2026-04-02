import { RepoLanguage } from "@/lib/types";

export function getLanguageSystemsDynamics(lang?: RepoLanguage): string {
  switch (lang) {
    case "rust":
      return `
  - Concurrency & Ownership: Threading models, locks (Mutex, RwLock), ownership patterns (Arc, Send/Sync), and cross-thread channels.
  - Memory & Lifetimes: Heap vs stack, lifetime constraints ('a), and zero-cost abstractions.
  - Native Integration: FFI (extern "C"), bindgen, and low-level hardware interaction.
  - Error Handling: Result/Option patterns, panic boundaries, and error propagation.
  - Abstractions: Traits, associated types, and generic implementations.`;
    case "c":
      return `
  - Memory Management: Manual allocation (malloc/free), pointer arithmetic, and buffer safety.
  - Symbol Visibility: Global symbols, static vs extern, and EXPORT_SYMBOL patterns.
  - Hardware Interaction: Direct register access, MMIO, interrupts, and assembly inserts.
  - Preprocessor & Build: Macros, conditional compilation (#ifdef), and Makefile/Kbuild structure.
  - Concurrency: pthreads, spinlocks, and atomic operations.`;
    case "cpp":
      return `
  - Memory & Ownership: RAII, smart pointers (unique_ptr, shared_ptr), and stack vs heap allocation.
  - Templates & Generics: Class/function templates, type deduction, and SFINAE.
  - Concurrency: std::thread, mutex, atomics, futures, and async.
  - ABI & Symbol Management: Name mangling, inline functions, and dynamic/shared libraries.
  - Performance: Move semantics, inline expansion, and cache-friendly data structures.`;
    case "go":
      return `
  - Concurrency: Goroutines, channels, waitgroups, and the select statement.
  - Memory: Pointer usage vs values, garbage collection impact, and stack escapes.
  - Interfaces: Implicit interface satisfaction and duck-typing patterns.
  - Error Handling: Explicit 'if err != nil' patterns and recovery from panics.
  - Messaging: Buffer capacities, backpressure, and cross-package communication.`;
    case "python":
      return `
  - Async/Await: Event loops, tasks, and concurrent execution (asyncio/threading).
  - C-Extensions: Integration with native code and performance-critical modules.
  - Concurrency: GIL management, multiprocessing vs multithreading.
  - Abstractions: Decorators, metaclasses, and protocol definitions.
  - Memory: Object references, garbage collection, and resource cleanup (context managers).`;
    case "java":
      return `
  - JVM/Runtime: Class loading, garbage collection, and JIT optimization.
  - Multithreading: Thread pools, synchronized blocks, and concurrent collections.
  - Abstractions: Inheritance, interfaces, and reflection-based frameworks (Spring).
  - Memory: Heap management, stack traces, and resource pooling.
  - Error Paths: Try-catch-finally blocks and custom exception hierarchies.`;
    case "ruby":
      return `
  - Concurrency: Threads, fibers, and global interpreter lock (GIL) implications.
  - Memory & GC: Object heap, symbol table, and garbage collection cycles.
  - Metaprogramming: Dynamic method definitions, mixins, and class reopening.
  - Error Handling: Exceptions, rescue/ensure, and standard library patterns.
  - DSLs & Abstractions: Blocks, procs, and flexible domain-specific constructs.`;
    case "c_sharp":
      return `
  - CLR & Runtime: Garbage collection, JIT compilation, and assemblies.
  - Concurrency: async/await, Tasks, ThreadPool, and synchronization primitives.
  - Type System: Generics, reflection, interfaces, and inheritance.
  - Memory: Value vs reference types, stack/heap behavior, and resource disposal (IDisposable).
  - Error Handling: Exceptions, try/catch/finally, and custom exception hierarchies.`;
    case "php":
      return `
  - Runtime & Execution: Zend engine, opcode compilation, and request lifecycle.
  - Memory: Reference vs copy, garbage collection, and persistent/static storage.
  - Concurrency: Process/thread models (e.g., pthreads extension) and async via ReactPHP.
  - Error Handling: Exceptions, warnings, notices, and custom error handlers.
  - Abstractions: Classes, interfaces, traits, and dynamic typing.`;
    case "swift":
      return `
  - Memory & Ownership: ARC (Automatic Reference Counting), strong/weak/unowned references.
  - Concurrency: async/await, actors, GCD (Grand Central Dispatch), and thread safety.
  - Error Handling: do/try/catch, throwing functions, and Result types.
  - Protocols & Generics: Protocol-oriented design, associated types, and extensions.
  - Integration: Interoperability with Objective-C and system frameworks.`;
    case "kotlin":
      return `
  - Memory & JVM: JVM memory model, garbage collection, and object lifecycles.
  - Concurrency: Coroutines, channels, and structured concurrency.
  - Type System: Null safety, generics, extension functions, and sealed classes.
  - Error Handling: Exceptions and functional error-handling patterns.
  - Interoperability: Java interop and annotation-driven frameworks (Spring/Ktor).`;
    case "dart":
      return `
  - Concurrency: Isolates, Futures, Streams, and async/await patterns.
  - Memory: Heap management, object references, and garbage collection.
  - Abstractions: Classes, mixins, interfaces, and generics.
  - Error Handling: Exceptions, try/catch, and asynchronous error propagation.
  - Flutter Integration: Widget tree, state management, and rendering pipeline.`;
    case "shell":
      return `
  - Execution Model: Scripts, pipelines, subshells, and process spawning.
  - Variables & Scope: Environment, local vs global, and parameter expansion.
  - I/O & Redirection: Pipes, stdin/stdout, file descriptors, and command substitution.
  - Concurrency: Background jobs, process substitution, traps, and wait/polling.
  - Error Handling: Exit codes, set -e, and custom error functions.`;
    case "typescript":
      return `
  - Type System: Strong typing, interfaces, generics, and type guards.
  - Concurrency: Async/await, Promises, and event loop interactions.
  - Memory: Garbage-collected heap, object references, and closures.
  - Integration: JS interop and module resolution.
  - Error Handling: Exceptions, strict null checks, and runtime validation.`;
    case "javascript":
      return `
  - Event Loop: Task queues, microtasks, and concurrency with async/await.
  - Memory & GC: Closures, heap vs stack allocation, and garbage collection.
  - Modules: ES modules, CommonJS, and dependency resolution.
  - Error Handling: try/catch, promises, and callback error patterns.
  - DOM & APIs: Event-driven model, timers, and browser integration.`;
    case "scala":
      return `
  - JVM/Runtime: Garbage collection, JIT, and class loading.
  - Concurrency: Akka actors, Futures, and parallel collections.
  - Functional Abstractions: Immutable data, monads, and higher-order functions.
  - Type System: Traits, generics, and pattern matching.
  - Error Handling: Try/Success/Failure and exception propagation.`;
    case "haskell":
      return `
  - Lazy Evaluation: Thunks, demand-driven computation, and space leaks.
  - Concurrency: STM, async, threads, and green-thread scheduling.
  - Type System: Algebraic data types, type classes, and monads.
  - Memory: Garbage collection, heap vs stack, and strictness annotations.
  - Error Handling: Either, Maybe, and exception monads.`;
    case "elixir":
      return `
  - Concurrency: Actor model, processes, message passing, and supervisors.
  - Memory: BEAM VM garbage collection, process heaps, and shared nothing model.
  - Functional Abstractions: Pattern matching, immutability, and pipelines.
  - Error Handling: Supervisors, try/rescue, and fault-tolerant design.
  - OTP: GenServer, Tasks, and application-level abstractions.`;
    case "clojure":
      return `
  - Concurrency: Software transactional memory, atoms, agents, futures.
  - Functional Abstractions: Immutability, higher-order functions, and lazy sequences.
  - JVM/Runtime: Garbage collection, JIT, and interoperability.
  - Error Handling: Exceptions, try/catch, and functional error wrappers.
  - State Management: Refs, vars, and agents.`;
    case "perl":
      return `
  - Execution Model: Interpreted, scripts, and REPL.
  - Memory: Scalars, arrays, hashes, and garbage collection.
  - Concurrency: fork, threads, and select/poll mechanisms.
  - Abstractions: Packages, references, objects (blessed), and closures.
  - Error Handling: eval, die, warn, and custom error handlers.`;
    case "r":
      return `
  - Memory: Vectors, lists, environments, and garbage collection.
  - Concurrency: Parallel package, multicore processing, and async libraries.
  - Functional Abstractions: Apply family, higher-order functions, and closures.
  - Data Flow: Data frames, tibbles, and matrices.
  - Error Handling: tryCatch, stop, and warnings.`;
    case "julia":
      return `
  - Memory: Stack vs heap, garbage collection, and mutable vs immutable types.
  - Concurrency: Tasks, Channels, multi-threading, and distributed computing.
  - Type System: Multiple dispatch, parametric types, and abstract types.
  - Error Handling: try/catch, Results, and error propagation.
  - Integration: C/Fortran interop via ccall.`;
    case "objective_c":
      return `
  - Memory: Manual reference counting (retain/release) or ARC.
  - Concurrency: GCD, NSThread, and operation queues.
  - Runtime: Objective-C runtime, selectors, and messaging.
  - Abstractions: Classes, categories, protocols, and blocks.
  - Error Handling: Exceptions and NSError patterns.`;
    case "fortran":
      return `
  - Memory: Arrays, pointers, and stack/heap allocations.
  - Concurrency: Coarrays, OpenMP, MPI, and parallel loops.
  - Abstractions: Modules, derived types, and generic procedures.
  - Error Handling: I/O errors, numeric exceptions, and stop statements.
  - Performance: Vectorization, intrinsic functions, and loop optimization.`;
    case "assembly":
      return `
  - Memory & Registers: Stack/heap usage, segment registers, and calling conventions.
  - Instruction Flow: Branching, loops, and pipeline hazards.
  - Concurrency: Interrupts, spinlocks, and atomic operations.
  - I/O: MMIO, port access, and syscalls.
  - Optimization: Instruction scheduling, alignment, and inlining.`;
    case "lua":
      return `
  - Memory: Stack-based VM, garbage collection, and upvalues.
  - Concurrency: Coroutines and event-driven patterns.
  - Abstractions: Tables, metatables, and closures.
  - Error Handling: pcall, xpcall, and runtime errors.
  - Integration: C API and embedding into host applications.`;
    case "groovy":
      return `
  - Memory & Runtime: JVM memory, JIT, and dynamic typing.
  - Concurrency: GPars, Futures, and threads.
  - Abstractions: Classes, closures, metaprogramming, and traits.
  - Error Handling: try/catch, exception propagation.
  - Integration: Java interop and build automation.`;
    case "mixed":
      return `
  - Concurrency: Threads, async/await, coroutines, and cross-language communication.
  - Memory: Heap/stack, garbage collection, and reference ownership.
  - Integration: FFI, module interop, and mixed-language bindings.
  - Error Handling: Cross-language exceptions, error propagation, and recovery.
  - Abstractions: Core interfaces, adapters, and system-level types.`;
    default:
      return `
  - Concurrency: Threading models, synchronization, and parallel execution.
  - Memory: Resource management, lifetimes, and allocation strategies.
  - Integration: Cross-module communication and external system interactions.
  - Resilience: Error handling paths and recovery strategies.
  - Abstractions: Shared interfaces and core architectural types.`;
  }
}

export function getArchitectPrompt(
  query: string,
  lang?: RepoLanguage,
  reason?: string,
  covers?: string[],
): string {
  const langDynamics = getLanguageSystemsDynamics(lang);
  const reasonText = reason ? `\nPlanner's Intent / Reason: ${reason}` : "";
  const coversText =
    covers && covers.length > 0
      ? `\nPrimary Target Files: ${covers.join(", ")}`
      : "";

  return `You are a Senior Systems Architect. Analyze the repository as a connected system using the structured graph and file metadata.

Question: ${query}${reasonText}${coversText}

Instructions:

* Use the provided call_chains as the PRIMARY execution backbone. Expand them into full step-by-step flows.
* Use files[].symbols_defined and symbols_used to resolve where logic originates and how it propagates.
* Follow dependency edges (imports/imported_by) to reconstruct complete chains (including transitive dependencies).
* Do not isolate files — always explain behavior as part of a multi-file system.
* Include intermediate nodes even if they are not explicitly mentioned in the query.
* Track how data/state moves across the chain and where transformations occur.
* If multiple execution paths exist (eager vs graph, sync vs async), explicitly separate and explain them.
* Capture ${lang || "systems"}-level details:
${langDynamics}

Structure:

[Technical Analysis]

* End-to-end execution flow (anchored on call chains)
* Cross-file interactions (who calls whom and why)
* Data flow, state transitions, and side effects
* Systems Dynamics: Concurrency, memory management, and hardware/FFI integration
* Key abstractions, traits, and their responsibilities
* Error handling and failure recovery paths

SUMMARY:
Concise architectural conclusion.

RELEVANT_FILES:
- [Full path to file 1]
- [Full path to file 2]
- [Full path to file 3]

SOURCE_FILES:
- [Local chunk filename, e.g., file_001_NB3.txt]
- [Local chunk filename, e.g., file_002_NB7.txt]

Constraints:

* No fluff, no preambles
* No code blocks unless required
* Do not skip intermediate dependencies in a chain
* Prefer graph relationships over isolated file interpretation
* Use only provided context`;
}

export const DEEPSEEK_CODING_PROMPT = `### ROLE
You are a Lead Software Engineer specializing in code fixes and refactoring. Your job is to analyze the provided files and produce only the minimal code changes needed to address the task.

### CORE CONSTRAINTS
1. **NO COMMENTS:** Do not include any comments (// or /* */) in your output.
2. **NO PREAMBLE/POSTAMBLE:** Do not include introductory or concluding text. Output ONLY the code changes.
3. **MINIMAL CHANGES:** Output only the function, class, or block that needs to be modified, not the entire file.
4. **PRESERVE CONTEXT:** If the change requires adding or removing lines, show the affected code segment with enough surrounding context to be unambiguous.

### HANDOFF FORMAT (Provided by the Orchestrator)
You will receive a handoff block with the following fields:
- TASK_TYPE: [REFACTOR | FEATURE | FIX | OPTIMIZE | ADD | REMOVE | OTHERS]
- OBJECTIVE: [One-line goal]
- LOGIC_CONSTRAINTS: [Key rules]
- DEPENDENCIES: [Identifiers/functions to reference]
- CONTEXT_FILES: [List of part_XX_NBXX.txt files that contain the relevant source]

Your response must implement the OBJECTIVE, respecting all LOGIC_CONSTRAINTS, and using the DEPENDENCIES if needed. Do not output anything except the required code changes.

### EXAMPLE OUTPUT
If fixing a bug in a function:
\`\`\`
function buggyFunction(param) {
  // corrected implementation
}
\`\`\`

If adding a new function:
\`\`\`
function newFunction() {
  // implementation
}
\`\`\`

If the change is a small patch, you may output a unified diff format.

USER REQUEST: `;

export function getNotebooklmPlannerPrompt(query: string): string {
  return `You are a Lead Discovery Architect. Your job is to PLAN the minimal but COMPLETE context required to reconstruct execution flow.

Use:

* 00_Root_Manifest.txt → dependency graph + file structure
* 01_Meta.txt → high-level context

User Query:
${query}

---

DECISION:

PATH A — METADATA ONLY:
If the query is high-level only (summary, statistics, stack, purpose, general architecture) AND requires NO code-level tracing.

PATH B — EXECUTION TRACE (OR HYBRID):
If code-level reasoning is required, OR if the query asks for BOTH metadata (contributors, history, architecture) and an execution trace. Use this path to identify the FULL execution graph.

---

RULES FOR PATH B (CRITICAL):

* Identify the PRIMARY execution chain (entry → intermediate → terminal).
* Expand ALL dependencies along that chain:
  - imports (downstream)
  - callers (upstream)
  - transitive dependencies (A → B → C)
* Select files that define OR use critical symbols in the chain.
* Include SHARED STATE / GLOBAL anchors (configs, env, root types).
* Include LOOP DRIVERS / ITERATORS if the logic involves repeated execution (e.g., pipelines, reducers, control flow).
* Ensure the chain is CONTINUOUS — no missing intermediate nodes.
* Prefer execution completeness over minimal file count.

---

OUTPUT (JSON ONLY):

IF PATH A (METADATA ONLY):
{
  "direct_answer": "Provide a complete, self-contained technical explanation in markdown. Focus exclusively on repository metadata: architecture, key components, contributors, commit history, and high-level project purpose. Use headers and bullet points. No JSON or preambles."
}

IF CODE / EXECUTION QUERY:
{
  "include_meta": true, // Set to true if the query ALSO asks for architectural overview, history, contributors, or high-level context available in 01_Meta.txt.
  "notebooks": [
    {
      "name": "notebook_01",
      "covers": ["exact_file_path_from_manifestA", "exact_file_path_from_manifestB"],
      "reason": "Why these specific files are absolutely required to construct the missing chain.",
      "sub_question": "Explain how this segment contributes to the execution flow and interacts with adjacent nodes."
    }
  ]
} (JSON only)`;
}

export function getGapFillerPrompt(symbol: string, reason: string): string {
  return `You are a Systems Scout resolving a missing link in a codebase using structured graph context.

TARGET_SYMBOL: ${symbol}
GAP_REASON: ${reason}

Instructions:

* Use symbols_defined and symbols_used to locate where ${symbol} originates and how it propagates.
* Use dependency edges (imports/imported_by) to trace both directions:
  • Upstream → callers / dependents
  • Downstream → callees / dependencies
* If partial call_chains exist, COMPLETE them by inserting missing intermediate nodes.
* Reconstruct the SMALLEST complete execution chain that resolves the gap (no fragmentation).
* Ensure continuity: no broken links between files or symbols.
* Track how data/state flows through ${symbol} and how it influences execution.
* Include loops, aggregators, or control flow ONLY if they materially affect ${symbol}.
* Prefer graph-backed relationships over assumptions.

Structure:

[Technical Analysis]

* Role of ${symbol} in the system
* Completed call chain (upstream → ${symbol} → downstream)
* Data flow / state transitions
* Key dependencies and interactions

SUMMARY:
Concise explanation of how the gap is resolved and how the chain is now complete.

RELEVANT_FILES:

* [absolute repo path]

SOURCE_FILES:

* [chunk ids used]

Constraints:

* No preambles
* No code blocks unless required
* Do not invent missing links — if unresolved, the chain must remain partial
* Do not skip intermediate dependencies
* Use only provided scout context`;
}

export function getFinalPhasePrompt(
  q: string,
  lang?: RepoLanguage,
  filled = false,
): string {
  const gap = filled
    ? `### BRIDGED CONTEXT

* gap_filler_NB.txt is authoritative for resolved symbols.
* Prefer it over earlier context.
* Do not trigger PATH C for already resolved symbols.`
    : "";

  return `You are a Lead Systems Engineer. Process the query using the provided context.

### QUERY

${q}

### CONTEXT PRIORITY

1. gap_filler_NB.txt (if present)
2. phase2_insights.txt
3. 00_Root_Manifest.txt

---

### DECISION

PATH A — STRUCTURED CONTEXT (PRIMARY):
Generate a complete machine-readable representation of the system required to answer the query.

PATH B — OPERATIONAL:
Use if the query asks to fix, refactor, implement, or modify code.

PATH C — GAP:
Use ONLY if critical logic or symbols required to construct the structure are missing.

---

### RULES

* DO NOT produce human-readable explanations.
* ALWAYS prefer structured extraction over summarization.
* Extract FULL execution structure with CONTINUOUS chains (no missing intermediate nodes).
* Prioritize PRIMARY execution paths over secondary or rarely used flows.
* If multiple paths exist, include only those necessary to answer the query.
* If a required symbol, call chain, or dependency is missing → PATH C.
* Do not hallucinate missing logic.
* If context is sufficient → DO NOT use PATH C.

${gap}

---

### OUTPUT

#### PATH A (JSON only — STRUCTURED CONTEXT):

{
"files": [
{
"path": "absolute repo path",
"role": "entry | core | utility | config | test | unknown",
"symbols_defined": ["functions/classes/types"],
"symbols_used": ["external dependencies"],
"imports": ["resolved file paths"],
"summary": "concise technical role"
}
],
"call_chains": [
"entry → moduleA → moduleB → output"
],
"key_symbols": [
{
"name": "symbol_name",
"defined_in": "file path",
"used_in": ["file paths"]
}
],
"system_dynamics": {
  "context": "Specialized for ${lang || "General Systems"}",
  "details": "Technical breakdown of concurrency, memory, and native interaction"
},
"error_resilience": {
  "policies": "error handling paths, recovery strategies",
  "boundaries": "safety boundaries, fallback mechanisms"
}
}

---

#### PATH B (JSON only):

{
"intent": "REFACTOR | FIX | FEATURE | OTHERS",
"task": "Short actionable instruction",
"deepseek_handoff": {
"goal": "Definition of done",
"current_logic": "Existing behavior and issue",
"symbols": ["Key functions/types/constants"]
},
"extraction_manifest": [
{
"file_path": "absolute repo path",
"chunk_id": "chunk id",
"justification": "why needed"
}
]
}

---

#### PATH C (JSON only):

{
"status": "MISSING_CONTEXT",
"missing_link": {
"target_symbol": "name",
"reason": "why required",
"search_keywords": ["k1", "k2"]
}
}

---

### CONSTRAINTS

* Output MUST be valid JSON only
* Response MUST start with { and end with }
* NO text before or after JSON
* NO markdown
* Must be directly parseable by JSON.parse()
* Use only provided context
* Do not skip required dependencies`;
}

export function getStaffEngineerPrompt(
  query: string,
  jsonData: string,
): string {
  return `You are a Staff-Level Systems Engineer and Technical Educator.

Your task is to transform the structured JSON into a **clear, concise, deeply insightful explanation**. Do not restate the JSON; instead, reconstruct the system as a coherent mental model.

Answer the question:

"${query}"

**Instructions:**
- Provide only the answer. No preamble, no follow-ups, no commentary.
- Use the provided call_chains as the PRIMARY execution backbone. Expand them into full step-by-step flows.
- Use files[].symbols_defined and symbols_used to resolve where logic originates and how it propagates.
- Follow dependency edges (imports/imported_by) to reconstruct complete chains (including transitive dependencies).
- Do not isolate files — always explain behavior as part of a multi-file system.
- Include intermediate nodes even if they are not explicitly mentioned in the query.
- Track how data/state moves across the chain and where transformations occur.
- If multiple execution paths exist (eager vs graph, sync vs async), explicitly separate and explain them.
- Explain the system end-to-end, from entry point to core execution.
- Describe cross-file or cross-module interactions clearly.
- Detail how data and state are managed across components.
- Explain key abstractions and their purpose.
- Include a final mental model summary in 5–8 lines.
- Focus on “why” and “how,” not just “what.”
- Keep it precise, readable, and senior-engineer level.
- Avoid mechanical file listings, shallow explanations, or hallucinations.

**Output structure (follow exactly):**

1. **End-to-End Execution Flow** – step-by-step system narrative.
2. **Control Flow / Core Insights** – how execution and loops are managed, how state is preserved.
3. **Advanced System Dynamics** – low-level details on concurrency (\`Mutex\`/\`Arc\`), memory management (lifetimes/buffers), and FFI/Hardware interaction.
4. **Cross-File / Module Interactions** – responsibilities and collaborations.
5. **Data Flow & State Management** – how data moves and is stored.
6. **Key Abstractions & Traits** – detailed mapping of traits, interfaces, and core types.
7. **Resilience & Error Handling** – recovery paths, failure boundaries, and fallback mechanisms.
8. **Final Mental Model** – concise 5–8 line summary of the whole system.

**Input Data:**
${jsonData}`;
}
