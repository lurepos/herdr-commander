import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Problem } from "./problems.js";
import { parseProblems } from "./problems.js";
import type { VsTask } from "./task.js";
import { buildCommand, isCompositeTask, resolveTask, resolveTaskCwd, taskDependencies } from "./task.js";

export type TaskState = "queued" | "running" | "blocked" | "succeeded" | "failed" | "cancelled";
export type Placement = "current" | "right" | "down" | "tab";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface TaskRunResult {
  runId: string;
  task: string;
  state: TaskState;
  durationMs: number;
  paneId?: string;
  output?: string;
  problems?: Problem[];
  error?: string;
}

export interface RunContext {
  workspaceCwd: string;
  placement: Placement;
  herdr: string;
  signal: AbortSignal;
  inputs?: Record<string, string>;
  branch?: string;
  pane?: string;
  agent?: string;
  onStateChange?: (task: string, state: TaskState) => void;
  onOutput?: (task: string, output: string) => void;
}

interface RunningProcess {
  process: ChildProcess;
  operation: string;
}

let activeProcess: RunningProcess | undefined;

function formatCommand(executable: string, args: string[]): string {
  return [executable, ...args].map((part) => JSON.stringify(part)).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function currentPaneCommand(task: VsTask, command: string[]): string {
  if (task.command) return [task.command, ...(task.args ?? []).map(shellQuote)].join(" ");
  return command.map(shellQuote).join(" ");
}

export function runCommand(
  executable: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; operation: string; onOutput?: (output: string) => void },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeProcess = { process: child, operation: options.operation };

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (activeProcess?.process === child) activeProcess = undefined;
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      child.kill("SIGTERM");
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; options.onOutput?.(chunk); });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; options.onOutput?.(chunk); });
    child.once("error", (error) => finish(() => reject(new Error(`${options.operation} failed: ${error.message}`))));
    child.once("close", (exitCode, signal) => finish(() => resolve({ stdout, stderr, exitCode, signal })));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });
}

function getPaneId(response: unknown, key: "root_pane" | "pane"): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const result = (response as { result?: unknown }).result;
  if (!result || typeof result !== "object") return undefined;
  const paneContainer = (result as Record<string, unknown>)[key];
  if (!paneContainer || typeof paneContainer !== "object") return undefined;
  const paneId = (paneContainer as Record<string, unknown>).pane_id;
  return typeof paneId === "string" ? paneId : undefined;
}

async function runHerdrJson(herdr: string, args: string[], signal: AbortSignal, operation: string): Promise<unknown> {
  const result = await runCommand(herdr, args, { signal, operation });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode ?? "unknown"}`;
    throw new Error(`${operation} failed: ${detail}`);
  }
  if (!result.stdout.trim()) throw new Error(`${operation} failed: Herdr returned no JSON`);
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${operation} returned invalid JSON: ${detail}`);
  }
}

async function createPane(task: VsTask, context: RunContext): Promise<string> {
  const taskCwd = resolveTaskCwd(task, context.workspaceCwd);
  const envArgs = Object.entries(task.options?.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  if (context.placement === "current") {
    const response = await runHerdrJson(context.herdr, ["pane", "current"], context.signal, "herdr pane current");
    const paneId = getPaneId(response, "pane");
    if (!paneId) throw new Error(`herdr pane current returned no pane id for ${task.label}`);
    return paneId;
  }
  if (context.placement === "tab") {
    const response = await runHerdrJson(context.herdr, ["tab", "create", ...envArgs, "--cwd", taskCwd, "--label", task.label, "--focus"], context.signal, "herdr tab create");
    const paneId = getPaneId(response, "root_pane");
    if (!paneId) throw new Error(`herdr tab create returned no pane id for ${task.label}`);
    return paneId;
  }
  const direction = context.placement === "right" ? "right" : "down";
  const response = await runHerdrJson(context.herdr, ["pane", "split", "--direction", direction, ...envArgs, "--cwd", taskCwd, "--focus"], context.signal, "herdr pane split");
  const paneId = getPaneId(response, "pane");
  if (!paneId) throw new Error(`herdr pane split returned no pane id for ${task.label}`);
  return paneId;
}

export async function cancelActiveTask(herdr: string): Promise<void> {
  const current = activeProcess;
  if (!current) return;
  current.process.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (activeProcess?.process === current.process) activeProcess = undefined;
  void herdr;
}

async function executeSingleTask(task: VsTask, context: RunContext): Promise<TaskRunResult> {
  const runId = randomUUID();
  const started = Date.now();
  const resolvedTask = resolveTask(task, {
    workspaceFolder: context.workspaceCwd,
    ...(context.inputs === undefined ? {} : { inputs: context.inputs }),
    ...(context.branch === undefined ? {} : { branch: context.branch }),
    ...(context.pane === undefined ? {} : { pane: context.pane }),
    ...(context.agent === undefined ? {} : { agent: context.agent }),
  });
  context.onStateChange?.(task.label, "queued");
  try {
    if (context.signal.aborted) throw new Error("cancelled");
    context.onStateChange?.(task.label, "running");
    const paneId = await createPane(resolvedTask, context);
    const command = buildCommand(resolvedTask);
    let output = "";
    const taskCwd = resolveTaskCwd(resolvedTask, context.workspaceCwd);
    if (context.placement === "current") {
      const environment = Object.entries(resolvedTask.options?.env ?? {}).map(([key, value]) => shellQuote(`${key}=${value}`)).join(" ");
      const taskCommandText = currentPaneCommand(resolvedTask, command);
      const commandText = [
        `cd -- ${shellQuote(taskCwd)}`,
        environment ? `env ${environment} ${taskCommandText}` : taskCommandText,
      ].filter(Boolean).join(" && ");
      const textResult = await runCommand(context.herdr, ["pane", "send-text", paneId, commandText], {
        signal: context.signal,
        operation: `herdr pane send-text ${task.label}`,
      });
      if (textResult.exitCode !== 0) {
        throw new Error(textResult.stderr.trim() || textResult.stdout.trim() || `herdr pane send-text failed with exit code ${textResult.exitCode ?? "unknown"}`);
      }
      const enterResult = await runCommand(context.herdr, ["pane", "send-keys", paneId, "Enter"], {
        signal: context.signal,
        operation: `herdr pane send-keys ${task.label}`,
      });
      if (enterResult.exitCode !== 0) {
        throw new Error(enterResult.stderr.trim() || enterResult.stdout.trim() || `herdr pane send-keys failed with exit code ${enterResult.exitCode ?? "unknown"}`);
      }
      context.onStateChange?.(task.label, "succeeded");
      return { runId, task: task.label, state: "succeeded", durationMs: Date.now() - started, paneId, output: "" };
    }
    const runArgs = ["pane", "run", paneId, ...command];
    const result = await runCommand(context.herdr, runArgs, {
      signal: context.signal,
      operation: `herdr pane run ${task.label}`,
      onOutput: (chunk) => { output += chunk; context.onOutput?.(task.label, chunk); },
    });
    if (context.signal.aborted) throw new Error("cancelled");
    const problems = resolvedTask.problemMatcher ? parseProblems(output, resolvedTask.problemMatcher, { workspaceCwd: context.workspaceCwd, taskLabel: task.label }) : [];
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode ?? "unknown"}`;
      context.onStateChange?.(task.label, "failed");
      return { runId, task: task.label, state: "failed", durationMs: Date.now() - started, paneId, output, problems, error: `${detail} (${formatCommand(command[0] ?? "", command.slice(1))})` };
    }
    context.onStateChange?.(task.label, "succeeded");
    return { runId, task: task.label, state: "succeeded", durationMs: Date.now() - started, paneId, output, problems };
  } catch (error) {
    const cancelled = context.signal.aborted || (error instanceof Error && error.message === "cancelled");
    const state: TaskState = cancelled ? "cancelled" : "failed";
    context.onStateChange?.(task.label, state);
    return {
      runId,
      task: task.label,
      state,
      durationMs: Date.now() - started,
      ...(error instanceof Error ? { error: error.message } : { error: String(error) }),
    };
  }
}

export async function executeTask(task: VsTask, tasks: VsTask[], context: RunContext): Promise<TaskRunResult[]> {
  const byLabel = new Map(tasks.map((candidate) => [candidate.label, candidate]));
  const results = new Map<string, TaskRunResult>();
  const successful = new Map<string, boolean>();
  const visiting = new Set<string>();

  const visit = async (current: VsTask): Promise<void> => {
    if (results.has(current.label)) return;
    if (visiting.has(current.label)) throw new Error(`task dependency cycle includes ${current.label}`);
    visiting.add(current.label);
    const dependencies = taskDependencies(current);
    if ((current.dependsOrder ?? "sequence") === "parallel") {
      await Promise.all(dependencies.map(async (label) => {
        const dependency = byLabel.get(label);
        if (!dependency) throw new Error(`task ${current.label} depends on unknown task ${label}`);
        await visit(dependency);
      }));
    } else {
      for (const label of dependencies) {
        const dependency = byLabel.get(label);
        if (!dependency) throw new Error(`task ${current.label} depends on unknown task ${label}`);
        await visit(dependency);
      }
    }
    visiting.delete(current.label);
    if (results.has(current.label)) return;
    const dependencyFailed = dependencies.some((label) => successful.get(label) !== true);
    if (dependencyFailed) {
      const blocked: TaskRunResult = { runId: randomUUID(), task: current.label, state: "blocked", durationMs: 0, error: "dependency failed" };
      results.set(current.label, blocked);
      successful.set(current.label, false);
      context.onStateChange?.(current.label, "blocked");
      return;
    }
    if (isCompositeTask(current)) {
      successful.set(current.label, true);
      return;
    }
    const result = await executeSingleTask(current, context);
    results.set(current.label, result);
    successful.set(current.label, result.state === "succeeded");
  };

  await visit(task);
  return [...results.values()];
}
