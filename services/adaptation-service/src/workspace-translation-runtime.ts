import { createHash, randomUUID } from "node:crypto";
import type {
  WorkspaceCompilation, WorkspaceCompileCommand, WorkspaceTranslationRun,
} from "@forexplore/contracts";
import type { DeepSeekToolMessage } from "./deepseek-client";
import { compileWorkspace, validateWorkspaceCompileCommand } from "./workspace-compiler";
import { TranslationWorkspaceFiles, maxWorkspaceFileChars } from "./workspace-translation-files";
import {
  object, parseWorkspaceTranslationPlan, validateWorkspaceTranslationRequest,
  workspaceAnalyzerPrompt, workspaceAnalyzerTools, workspaceTranslatorPrompt, workspaceTranslatorTools,
  type WorkspaceTranslationModelClient,
} from "./workspace-translation-agent";

export interface WorkspaceTranslationRuntimeOptions {
  workspaceRoot: string;
  compileCommand: WorkspaceCompileCommand;
  client: WorkspaceTranslationModelClient;
  /** Budget per start/resume, including Analyzer and repair turns. */
  maxModelTurns?: number;
  timeoutMs?: number;
}

export class WorkspaceTranslationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const runningStatuses = new Set(["analyzing", "translating", "compiling"]);
const hash = (content: string | null) => content === null ? null : createHash("sha256").update(content).digest("hex");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One writer per configured workspace; durable before-images support restart and rollback. */
export class WorkspaceTranslationRuntime {
  private readonly files: TranslationWorkspaceFiles;
  private readonly command: WorkspaceCompileCommand;
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private closing = false;
  private active?: { run: WorkspaceTranslationRun; controller: AbortController; done: Promise<void> };

  constructor(private readonly options: WorkspaceTranslationRuntimeOptions) {
    validateWorkspaceCompileCommand(options.compileCommand);
    this.command = structuredClone(options.compileCommand);
    this.maxTurns = options.maxModelTurns ?? 80;
    this.timeoutMs = options.timeoutMs ?? 1_800_000;
    if (!Number.isInteger(this.maxTurns) || this.maxTurns < 1 || this.maxTurns > 1000 ||
      !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 7_200_000) {
      throw new Error("Invalid workspace translation execution budget.");
    }
    this.files = new TranslationWorkspaceFiles(options.workspaceRoot);
  }

  start(input: unknown): WorkspaceTranslationRun {
    this.requireIdle();
    try { validateWorkspaceTranslationRequest(input); }
    catch (error) { throw new WorkspaceTranslationError(400, message(error)); }
    const request = structuredClone(input);
    for (const path of new Set([...request.workspaceFiles, ...request.writeFiles])) this.files.read(path);
    const now = new Date().toISOString();
    const run: WorkspaceTranslationRun = {
      id: randomUUID(), workspaceRoot: this.files.root, request, status: "analyzing",
      createdAt: now, updatedAt: now, completedSteps: [], changes: [], compilations: [],
      modelTurns: 0, acceptance: "compilation-only",
    };
    this.save(run);
    return this.launch(run);
  }

  get(id: string): WorkspaceTranslationRun {
    if (this.active?.run.id === id) return structuredClone(this.active.run);
    let value: unknown;
    try { value = this.files.load(id); }
    catch (error) { throw new WorkspaceTranslationError(400, message(error)); }
    if (!value) throw new WorkspaceTranslationError(404, "Translation run was not found.");
    const run = this.validateRecord(value, id);
    if (runningStatuses.has(run.status)) {
      run.status = "interrupted";
      run.error = "Execution was interrupted. Resume to revalidate and continue.";
    }
    return run;
  }

  async cancel(id: string): Promise<WorkspaceTranslationRun> {
    const active = this.active;
    if (active?.run.id === id) {
      active.controller.abort(new Error("Translation cancelled."));
      await active.done;
    }
    return this.get(id);
  }

  resume(id: string): WorkspaceTranslationRun {
    this.requireIdle();
    const run = this.get(id);
    if (!["failed", "cancelled", "interrupted"].includes(run.status)) {
      throw new WorkspaceTranslationError(409, "Only failed, cancelled or interrupted runs can resume.");
    }
    this.reconcile(run);
    run.status = run.plan ? "translating" : "analyzing";
    delete run.error;
    this.save(run);
    return this.launch(run);
  }

  rollback(id: string): WorkspaceTranslationRun {
    this.requireIdle();
    const run = this.get(id);
    if (run.status === "rolled-back") return run;
    // Preflight every file before restoring any of them. Later user edits are never overwritten.
    this.reconcile(run, true);
    run.status = "rolling-back";
    this.save(run);
    try {
      for (const change of [...run.changes].reverse()) {
        if (change.rolledBack) continue;
        const current = this.files.read(change.path);
        if (current !== change.before) this.files.write(change.path, change.after, change.before);
        change.rolledBack = true;
        this.save(run);
      }
      run.status = "rolled-back";
      delete run.error;
      this.save(run);
    } catch (error) {
      run.error = message(error);
      this.save(run);
      throw error;
    }
    return structuredClone(run);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const active = this.active;
    if (!active) return;
    active.controller.abort(new Error("Translation interrupted by service shutdown."));
    await active.done;
  }

  private requireIdle(): void {
    if (this.closing) throw new WorkspaceTranslationError(503, "Workspace translation is shutting down.");
    if (this.active) throw new WorkspaceTranslationError(409, "A translation is already running in this workspace.");
  }

  private save(run: WorkspaceTranslationRun): void {
    run.updatedAt = new Date().toISOString();
    this.files.save(run.id, run);
  }

  private validateRecord(value: unknown, id: string): WorkspaceTranslationRun {
    const record = object(value);
    validateWorkspaceTranslationRequest(record.request);
    const run = record as unknown as WorkspaceTranslationRun;
    if (run.id !== id || run.workspaceRoot !== this.files.root || run.acceptance !== "compilation-only" ||
      ![...runningStatuses, "completed", "failed", "cancelled", "interrupted", "rolling-back", "rolled-back"].includes(run.status) ||
      !Array.isArray(run.changes) || !Array.isArray(run.compilations) || !Array.isArray(run.completedSteps) ||
      !Number.isInteger(run.modelTurns) || run.modelTurns < 0) throw new Error("Invalid translation record.");
    const paths = new Set<string>();
    for (const change of run.changes) {
      if (!change || !run.request.writeFiles.includes(change.path) || paths.has(change.path) ||
        (change.before !== null && typeof change.before !== "string") || typeof change.after !== "string" ||
        (change.pendingBefore !== undefined && change.pendingBefore !== null && typeof change.pendingBefore !== "string") ||
        typeof change.applied !== "boolean") throw new Error("Invalid translation file record.");
      paths.add(change.path);
    }
    if (run.plan) run.plan = parseWorkspaceTranslationPlan(run.plan, run.request);
    if (run.completedSteps.some((id) => !run.plan?.steps.some((step) => step.id === id))) {
      throw new Error("Invalid completed translation steps.");
    }
    return run;
  }

  private reconcile(run: WorkspaceTranslationRun, rollback = false): void {
    for (const change of run.changes) {
      const current = this.files.read(change.path);
      if (change.rolledBack) {
        if (current !== change.before) throw new WorkspaceTranslationError(409, `File changed after rollback: ${change.path}`);
      } else if (current === change.after) {
        change.applied = true;
        delete change.pendingBefore;
      } else if (change.pendingBefore !== undefined && current === change.pendingBefore) {
        if (current !== null) change.after = current;
        change.applied = current !== null;
        delete change.pendingBefore;
      } else if (current === change.before && (rollback || !change.applied)) {
        change.applied = false;
      } else {
        throw new WorkspaceTranslationError(409, `File changed outside this task: ${change.path}`);
      }
    }
  }

  private launch(run: WorkspaceTranslationRun): WorkspaceTranslationRun {
    const controller = new AbortController();
    const active = { run, controller, done: Promise.resolve() };
    this.active = active;
    active.done = Promise.resolve().then(async () => {
      const timeout = setTimeout(() => controller.abort(new Error("Translation execution timed out.")), this.timeoutMs);
      try {
        await this.execute(run, controller.signal);
      } catch (error) {
        run.status = controller.signal.aborted ? "cancelled" : "failed";
        run.error = message(controller.signal.aborted ? controller.signal.reason : error);
        this.save(run);
      } finally {
        clearTimeout(timeout);
        this.active = undefined;
      }
    });
    // Keep asynchronous persistence failures observable without an unhandled rejection.
    void active.done.catch((error) => console.error("Translation persistence failed:", error));
    return structuredClone(run);
  }

  private snapshot(run: WorkspaceTranslationRun): string {
    return JSON.stringify([...new Set([...run.request.workspaceFiles, ...run.request.writeFiles])]
      .sort().map((path) => [path, hash(this.files.read(path))]));
  }

  private async execute(run: WorkspaceTranslationRun, signal: AbortSignal): Promise<void> {
    let analyzer = !run.plan;
    let revisionReason = "";
    let successfulSnapshot: string | undefined;
    const readHashes = new Map<string, string | null>();
    const readable = new Set([...run.request.workspaceFiles, ...run.request.writeFiles]);
    const makeMessages = (): DeepSeekToolMessage[] => [
      { role: "system", content: analyzer ? workspaceAnalyzerPrompt : workspaceTranslatorPrompt },
      { role: "user", content: JSON.stringify({
        request: run.request, plan: run.plan, completedSteps: run.completedSteps,
        changes: run.changes.map(({ path, applied }) => ({ path, applied })),
        latestCompilation: run.compilations.at(-1), revisionReason,
      }) },
    ];
    let messages = makeMessages();
    for (let turn = 0; turn < this.maxTurns; turn++) {
      signal.throwIfAborted();
      run.status = analyzer ? "analyzing" : "translating";
      run.modelTurns++;
      this.save(run);
      const completion = await this.options.client.complete(messages,
        analyzer ? workspaceAnalyzerTools : workspaceTranslatorTools, signal);
      signal.throwIfAborted();
      const calls = completion.toolCalls ?? [];
      if (calls.length > 32) throw new Error("Model returned too many tool calls in one turn.");
      messages.push({ role: "assistant", content: completion.content ?? "", toolCalls: calls });
      if (!calls.length) {
        messages.push({ role: "user", content: "Continue using the supplied tools, or describe the unresolved scope in a plan revision." });
        continue;
      }
      let transition = false;
      for (const call of calls) {
        signal.throwIfAborted();
        let result: unknown;
        try {
          const args = object(JSON.parse(call.arguments));
          if (transition) throw new Error("Agent phase changed; retry this tool in the next phase.");
          const available = analyzer ? workspaceAnalyzerTools : workspaceTranslatorTools;
          const definition = available.find((tool) => tool.name === call.name);
          if (!definition) throw new Error(`Tool is unavailable in this phase: ${call.name}`);
          const properties = definition.inputSchema.properties as Record<string, unknown>;
          const required = definition.inputSchema.required as string[];
          if (Object.keys(args).some((key) => !(key in properties)) || required.some((key) => !(key in args))) {
            throw new Error("Tool arguments do not match its schema.");
          }
          switch (call.name) {
            case "report_blocker": {
              if (typeof args.reason !== "string" || !args.reason.trim()) throw new Error("A blocker requires a reason.");
              run.status = "failed";
              run.error = args.reason;
              this.save(run);
              return;
            }
            case "read_file": {
              if (typeof args.path !== "string" || !readable.has(args.path)) throw new Error("File is outside the requested read scope.");
              const content = this.files.read(args.path);
              readHashes.set(args.path, hash(content));
              result = { path: args.path, content, hash: hash(content) };
              break;
            }
            case "submit_plan": {
              run.plan = parseWorkspaceTranslationPlan(args, run.request);
              run.completedSteps = [];
              analyzer = false;
              transition = true;
              result = { accepted: true };
              break;
            }
            case "write_file": {
              const path = args.path;
              if (typeof path !== "string" || !run.request.writeFiles.includes(path) ||
                !run.plan?.steps.some((step) => step.files.includes(path))) throw new Error("File is outside the implementation plan.");
              if (typeof args.content !== "string" || args.content.length > maxWorkspaceFileChars) throw new Error("Invalid file content.");
              if (!readHashes.has(path) || args.expectedHash !== readHashes.get(path)) throw new Error("Read the file before writing and supply its hash.");
              const beforeWrite = this.files.read(path);
              if (hash(beforeWrite) !== args.expectedHash) throw new Error(`File changed since read: ${path}`);
              let change = run.changes.find((item) => item.path === path);
              if (change && beforeWrite !== (change.applied ? change.after : change.before)) throw new Error(`File changed outside this task: ${path}`);
              const previous = change ? structuredClone(change) : undefined;
              if (!change) {
                change = { path, before: beforeWrite, after: args.content, applied: false };
                run.changes.push(change);
              } else {
                change.after = args.content;
                change.applied = false;
              }
              change.pendingBefore = beforeWrite;
              successfulSnapshot = undefined;
              // A shared-file repair invalidates its steps and every dependent step.
              const invalid = new Set(run.plan!.steps.filter((step) => step.files.includes(path)).map((step) => step.id));
              for (const step of run.plan!.steps) if (step.dependsOn.some((id) => invalid.has(id))) invalid.add(step.id);
              run.completedSteps = run.completedSteps.filter((id) => !invalid.has(id));
              this.save(run);
              try { this.files.write(path, beforeWrite, args.content); }
              catch (error) {
                if (previous) {
                  delete change.pendingBefore;
                  Object.assign(change, previous);
                }
                else run.changes = run.changes.filter((item) => item !== change);
                this.save(run);
                throw error;
              }
              change.applied = true;
              delete change.pendingBefore;
              readHashes.delete(path);
              result = { path, hash: hash(args.content) };
              break;
            }
            case "complete_step": {
              const step = run.plan?.steps.find((step) => step.id === args.stepId);
              if (!step || step.dependsOn.some((id) => !run.completedSteps.includes(id)) ||
                step.files.some((path) => !run.changes.some((change) => change.path === path && change.applied))) {
                throw new Error("Complete dependencies and write every step file before completing this step.");
              }
              if (!run.completedSteps.includes(step.id)) run.completedSteps.push(step.id);
              result = { completedSteps: run.completedSteps };
              break;
            }
            case "get_changes": result = run.changes; break;
            case "compile": {
              this.reconcile(run);
              run.status = "compiling";
              this.save(run);
              const before = this.snapshot(run);
              const compilation: WorkspaceCompilation = await compileWorkspace(this.files.root, this.command, signal);
              run.compilations.push(compilation);
              successfulSnapshot = compilation.success && before === this.snapshot(run) ? before : undefined;
              run.status = "translating";
              result = { ...compilation, filesUnchanged: successfulSnapshot !== undefined };
              break;
            }
            case "revise_plan": {
              if (typeof args.reason !== "string" || !args.reason.trim()) throw new Error("Plan revision requires a reason.");
              revisionReason = args.reason;
              analyzer = true;
              delete run.plan;
              run.completedSteps = [];
              successfulSnapshot = undefined;
              transition = true;
              result = { accepted: true };
              break;
            }
            case "finish": {
              this.reconcile(run);
              if (!run.plan || run.plan.steps.some((step) => !run.completedSteps.includes(step.id)) ||
                successfulSnapshot === undefined || successfulSnapshot !== this.snapshot(run)) {
                throw new Error("Finish requires all plan steps and a passing compilation after the latest file changes.");
              }
              signal.throwIfAborted();
              run.status = "completed";
              this.save(run);
              return;
            }
          }
        } catch (error) {
          signal.throwIfAborted();
          result = { error: message(error) };
        }
        this.save(run);
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
      }
      if (transition) {
        readHashes.clear();
        messages = makeMessages();
      } else if (messages.reduce((size, item) => size + item.content.length, 0) > 1_500_000) {
        // Restart from durable state instead of retaining unbounded file/diagnostic history.
        readHashes.clear();
        messages = makeMessages();
      }
    }
    throw new Error(`Translation exhausted its ${this.maxTurns}-turn budget. Resume to continue.`);
  }
}
