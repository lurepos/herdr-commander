import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { executeTask, type Placement, cancelActiveTask, type TaskState } from "./runner.js";
import { buildCommand, loadTaskConfig, TasksFileNotFoundError, type TaskConfig, type TaskInput, type VsTask } from "./task.js";

function log(message: string) {
  appendFileSync("/tmp/herdr-vscode-tasks.log", `${new Date().toISOString()} ${message}\n`);
}

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const configuredCwd = process.env.HERDR_WORKSPACE_CWD ?? process.env.HERDR_PANE_CWD;

const ESC = "\x1b";
const CLEAR = `${ESC}[2J${ESC}[H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;

function highlight(value: string) { return `${BOLD}${value}${RESET}`; }
function dim(value: string) { return `${DIM}${value}${RESET}`; }
function selected(value: string) { return `▶ ${value}`; }
function normal(value: string) { return `  ${value}`; }

function currentPaneCwd(): Promise<string> {
  return new Promise((resolveCwd, reject) => {
    const child = spawn(herdr, ["pane", "current"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => reject(new Error(`Cannot find Herdr CLI: ${error.message}`)));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`herdr pane current failed: ${stderr.trim() || `exit code ${code ?? "unknown"}`}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { result?: { pane?: { cwd?: string; foreground_cwd?: string } } };
        const cwd = parsed.result?.pane?.cwd ?? parsed.result?.pane?.foreground_cwd;
        if (!cwd) throw new Error("Herdr returned no workspace directory");
        resolveCwd(resolve(cwd));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

interface PickerItem<T> {
  value: T;
  label: string;
  detail?: string;
  searchable: string;
}

export const PICKER_BACK = Symbol("picker-back");

function taskItems(tasks: VsTask[], states: Map<string, TaskState>): PickerItem<VsTask>[] {
  return tasks.map((task) => {
    const state = states.get(task.label);
    const command = task.type === "npm" ? `npm run ${task.script ?? "?"}` : task.command ?? "no command";
    const dependency = task.dependsOn ? ` · depends on ${typeof task.dependsOn === "string" ? task.dependsOn : task.dependsOn.join(", ")}` : "";
    return {
      value: task,
      label: task.label,
      detail: `[${task.type}] ${command}${state ? ` · ${state}` : ""}${dependency}`,
      searchable: `${task.label} ${task.type} ${task.detail ?? ""} ${command} ${dependency}`.toLowerCase(),
    };
  });
}

function placementItems(): PickerItem<{ label: string; value: Placement }>[] {
  return [
    { value: { label: "Run in new tab", value: "tab" }, label: "Run in new tab", detail: "Create a dedicated Herdr tab", searchable: "run in new tab tab" },
    { value: { label: "Run in right pane", value: "right" }, label: "Run in right pane", detail: "Split the current workspace to the right", searchable: "run in right pane right" },
    { value: { label: "Run in bottom pane", value: "down" }, label: "Run in bottom pane", detail: "Split the current workspace below", searchable: "run in bottom pane down bottom" },
  ];
}

async function currentPaneIsAvailable(): Promise<boolean> {
  try {
    const child = spawn(herdr, ["pane", "current"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    const result = await new Promise<{ code: number | null; stdout: string }>((resolveResult) => {
      child.once("error", () => resolveResult({ code: 1, stdout }));
      child.once("close", (code) => resolveResult({ code, stdout }));
    });
    if (result.code !== 0) return false;
    const parsed = JSON.parse(result.stdout) as { result?: { pane?: Record<string, unknown> } };
    const pane = parsed.result?.pane;
    if (!pane) return false;
    const occupied = [pane.busy, pane.occupied, pane.running].some((value) => value === true);
    const status = pane.status ?? pane.state;
    return !occupied && status !== "busy" && status !== "running";
  } catch {
    return false;
  }
}

async function resolveInputs(inputs: TaskInput[]): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const input of inputs) {
    if (input.type === "command") throw new Error(`input ${input.id} uses unsupported command resolver`);
    if (input.type === "pickString" && input.options?.length) {
      const selectedValue = await picker(input.options.map((option) => ({ value: option, label: option, searchable: option.toLowerCase() })), input.description ?? input.id);
      if (selectedValue === null) throw new Error("input selection cancelled");
      values[input.id] = selectedValue;
      continue;
    }
    const answer = await new Promise<string | null>((resolveAnswer) => {
      process.stdout.write(`${input.description ?? input.id}${input.default ? ` [${input.default}]` : ""}: `);
      process.stdin.setRawMode?.(false);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      const onData = (chunk: string) => {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        const value = chunk.trim();
        resolveAnswer(value || input.default || "");
      };
      process.stdin.once("data", onData);
    });
    if (answer === null) throw new Error("input selection cancelled");
    values[input.id] = answer;
  }
  return values;
}

export function filterItems<T>(items: PickerItem<T>[], query: string): PickerItem<T>[] {
  const normalized = query.trim().toLowerCase();
  return normalized ? items.filter((item) => item.searchable.includes(normalized)) : items;
}

export function picker<T>(items: PickerItem<T>[], title: string): Promise<T | null>;
export function picker<T>(items: PickerItem<T>[], title: string, options: { escape: "back" }): Promise<T | null | typeof PICKER_BACK>;
export function picker<T>(items: PickerItem<T>[], title: string, options: { escape?: "cancel" | "back" } = {}): Promise<T | null | typeof PICKER_BACK> {
  return new Promise((resolvePicker) => {
    let index = 0;
    let query = "";
    let visible = filterItems(items, query);
    let done = false;

    const cleanup = () => {
      if (done) return;
      done = true;
      process.stdin.removeListener("data", onKey);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdout.write(SHOW_CURSOR);
      process.stdout.write(CLEAR);
    };
    const finish = (value: T | null | typeof PICKER_BACK) => {
      cleanup();
      resolvePicker(value);
    };
    const render = () => {
      visible = filterItems(items, query);
      index = Math.min(index, Math.max(visible.length - 1, 0));
      process.stdout.write(CLEAR);
      process.stdout.write(`${highlight(title)}\n`);
      process.stdout.write(dim(`Type to filter · ↑↓/j/k move · Enter select · q quit${options.escape === "back" ? " · Esc back" : ""}\n`));
      process.stdout.write(`${dim(`Filter: ${query || "all"} · ${visible.length}/${items.length}`)}\n\n`);
      if (visible.length === 0) {
        process.stdout.write(dim("No matching tasks. Press Backspace to clear the filter.\n"));
        return;
      }
      visible.forEach((item, itemIndex) => {
        const line = `${item.label}${item.detail ? `  ${dim(item.detail)}` : ""}`;
        process.stdout.write(`${itemIndex === index ? selected(line) : normal(line)}\n`);
      });
    };
    const onKey = (key: string) => {
      if (key === "\x1b[A" || key === "k") { index = (index - 1 + visible.length) % Math.max(visible.length, 1); render(); }
      else if (key === "\x1b[B" || key === "j") { index = (index + 1) % Math.max(visible.length, 1); render(); }
      else if (key === "\r" || key === "\n") { finish(visible[index]?.value ?? null); }
      else if (key === "\x7f" || key === "\b") { query = query.slice(0, -1); render(); }
      else if (key === "q" || key === "\x03") { finish(null); }
      else if (key === "\x1b") { finish(options.escape === "back" ? PICKER_BACK : null); }
      else if (key.length === 1 && key >= " ") { query += key; index = 0; render(); }
    };

    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdout.write(HIDE_CURSOR);
    process.stdin.on("data", onKey);
    render();
  });
}

function printError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n${BOLD}Task failed${RESET}\n${message}\n`);
}

async function main() {
  log("Starting main...");
  const cwd = configuredCwd ? resolve(configuredCwd) : await currentPaneCwd();
  let config: TaskConfig;
  try {
    config = loadTaskConfig(cwd);
  } catch (error) {
    if (!(error instanceof TasksFileNotFoundError)) throw error;
    await picker([
      {
        value: null,
        label: "Searched upward from",
        detail: JSON.stringify(error.searchedPaths),
        searchable: `.vscode tasks.json ${error.searchedPaths.join(" ")}`,
      },
    ], "No .vscode/tasks.json found");
    return;
  }
  const workspaceCwd = config.workspaceCwd;
  const tasks = config.tasks;
  log(`Tasks found: ${tasks.length}`);
  if (tasks.length === 0) throw new Error(`No tasks configured in ${cwd}/.vscode/tasks.json`);

  const states = new Map<string, TaskState>();
  const workspaceName = basename(config.workspaceCwd);
  while (true) {
    const task = await picker(taskItems(tasks, states), workspaceName);
    if (!task) return;

    const placements = placementItems();
    if (task.dependsOn === undefined && await currentPaneIsAvailable()) {
      placements.push({ value: { label: "Current pane", value: "current" }, label: "Current pane", detail: "Run in the selected pane", searchable: "current pane selected" });
    }
    const placement = await picker(placements, `${workspaceName} - ${task.label}`, { escape: "back" });
    if (placement === PICKER_BACK) continue;
    if (!placement) return;

    const inputs = await resolveInputs(config.inputs);

    const controller = new AbortController();
    const onInterrupt = () => {
      controller.abort();
      void cancelActiveTask(herdr);
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    try {
      let retry = true;
      while (retry) {
        retry = false;
        const results = await executeTask(task, tasks, {
        workspaceCwd,
        placement: placement.value,
        herdr,
        signal: controller.signal,
        inputs,
        onStateChange: (label, state) => {
          states.set(label, state);
          process.stdout.write(`${dim(`${label}: ${state}`)}\n`);
        },
        onOutput: (label, chunk) => process.stdout.write(dim(`${label}: ${chunk}`)),
        });
        const result = results.at(-1);
        if (result?.state === "failed" || result?.state === "blocked" || result?.state === "cancelled") {
          if (result.state !== "cancelled") {
            const action = await picker([
              { value: "retry", label: "Retry task", ...(result.error ? { detail: result.error } : {}), searchable: `retry ${result.error ?? ""}` },
              { value: "exit", label: "Exit", searchable: "exit" },
            ], `${task.label} failed`);
            if (action === "retry") { retry = true; continue; }
          }
          throw new Error(result.error ?? `${task.label}: ${result.state}`);
        }
        process.stdout.write(`${BOLD}${task.label}: ${result?.state ?? "done"} (${result?.durationMs ?? 0}ms, ${result?.problems?.length ?? 0} problems)${RESET}\n`);
      }
      return;
    } finally {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
    }
  }
}

main().catch((error) => {
  log(`Uncaught error: ${String(error)}`);
  printError(error);
  process.exitCode = 1;
});

void homedir;
void buildCommand;
