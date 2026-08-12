import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface VsTask {
  label: string;
  type?: string;
  detail?: string;
  command?: string;
  args?: string[];
  script?: string;
  dependsOn?: string | string[];
  dependsOrder?: "sequence" | "parallel";
  group?: string | { kind: string; isDefault?: boolean };
  problemMatcher?: string | ProblemMatcher | Array<string | ProblemMatcher>;
  isBackground?: boolean;
  presentation?: { reveal?: "always" | "silent" | "never"; panel?: "shared" | "dedicated" | "new" };
  options?: {
    cwd?: string;
    env?: Record<string, string>;
  };
}

export interface ProblemPattern {
  regexp: string;
  file?: number;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  severity?: number;
  code?: number;
  message?: number;
}

export interface ProblemMatcher {
  owner?: string;
  source?: string;
  severity?: "error" | "warning" | "info";
  fileLocation?: "absolute" | "relative" | ["relative", string];
  pattern?: string | ProblemPattern | Array<string | ProblemPattern>;
}

export interface TaskInput {
  id: string;
  type?: "promptString" | "pickString" | "command";
  description?: string;
  default?: string;
  options?: string[];
  command?: string;
}

export interface TaskConfig {
  tasks: VsTask[];
  inputs: TaskInput[];
  workspaceCwd: string;
  tasksPath: string;
}

export class TasksFileNotFoundError extends Error {
  constructor(public readonly searchedPaths: string[]) {
    super("tasks file not found");
    this.name = "TasksFileNotFoundError";
  }
}

export function parseJsonc(source: string, fileName = "tasks.json"): unknown {
  let stripped = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        stripped += char;
      } else {
        stripped += " ";
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        stripped += "  ";
        i += 1;
      } else {
        stripped += char === "\n" ? "\n" : " ";
      }
      if (char === "*" && next === "/") inBlockComment = false;
      continue;
    }

    if (inString) {
      stripped += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      stripped += char;
    } else if (char === "/" && next === "/") {
      inLineComment = true;
      stripped += "  ";
      i += 1;
    } else if (char === "/" && next === "*") {
      inBlockComment = true;
      stripped += "  ";
      i += 1;
    } else {
      stripped += char;
    }
  }

  let json = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < stripped.length; i += 1) {
    const char = stripped[i];
    if (inString) {
      json += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      json += char;
      continue;
    }
    if (char === ",") {
      let next = i + 1;
      while (/\s/.test(stripped[next] ?? "")) next += 1;
      if (stripped[next] === "}" || stripped[next] === "]") continue;
    }
    json += char;
  }

  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${fileName}: invalid JSONC (${message})`);
  }
}

function asTask(value: unknown, index: number, fileName: string): VsTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fileName}: task ${index + 1} must be an object`);
  }
  const task = value as Record<string, unknown>;
  if (typeof task.label !== "string" || task.label.trim() === "") {
    throw new Error(`${fileName}: task ${index + 1} needs a non-empty label`);
  }
  if (task.type !== undefined && typeof task.type !== "string") {
    throw new Error(`${fileName}: task ${task.label} type must be a string`);
  }
  if (task.args !== undefined && (!Array.isArray(task.args) || task.args.some((arg) => typeof arg !== "string"))) {
    throw new Error(`${fileName}: task ${task.label} args must be strings`);
  }
  if (task.dependsOn !== undefined && typeof task.dependsOn !== "string" &&
      (!Array.isArray(task.dependsOn) || task.dependsOn.some((dependency) => typeof dependency !== "string"))) {
    throw new Error(`${fileName}: task ${task.label} dependsOn must contain task labels`);
  }
  if (task.dependsOrder !== undefined && task.dependsOrder !== "sequence" && task.dependsOrder !== "parallel") {
    throw new Error(`${fileName}: task ${task.label} dependsOrder must be sequence or parallel`);
  }
  if (task.group !== undefined && typeof task.group !== "string" &&
      (!task.group || typeof task.group !== "object" || typeof (task.group as Record<string, unknown>).kind !== "string")) {
    throw new Error(`${fileName}: task ${task.label} group must be a string or object`);
  }

  const options = task.options;
  if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options))) {
    throw new Error(`${fileName}: task ${task.label} options must be an object`);
  }
  const parsedOptions = options as Record<string, unknown> | undefined;
  if (parsedOptions?.env !== undefined &&
      (!parsedOptions.env || typeof parsedOptions.env !== "object" || Array.isArray(parsedOptions.env) ||
       Object.values(parsedOptions.env).some((env) => typeof env !== "string"))) {
    throw new Error(`${fileName}: task ${task.label} options.env must map names to strings`);
  }

  return {
    label: task.label,
    ...(typeof task.type === "string" ? { type: task.type } : {}),
    ...(typeof task.detail === "string" ? { detail: task.detail } : {}),
    ...(typeof task.command === "string" ? { command: task.command } : {}),
    ...(typeof task.script === "string" ? { script: task.script } : {}),
    ...(Array.isArray(task.args) ? { args: task.args as string[] } : {}),
    ...(typeof task.dependsOn === "string" || Array.isArray(task.dependsOn) ?
      { dependsOn: task.dependsOn as string | string[] } : {}),
    ...(task.dependsOrder === "sequence" || task.dependsOrder === "parallel" ?
      { dependsOrder: task.dependsOrder } : {}),
    ...(typeof task.group === "string" ? { group: task.group } :
      task.group && typeof task.group === "object" ? { group: task.group as { kind: string; isDefault?: boolean } } : {}),
    ...(typeof task.problemMatcher === "string" ? { problemMatcher: task.problemMatcher } :
      Array.isArray(task.problemMatcher) ? { problemMatcher: task.problemMatcher as Array<string | ProblemMatcher> } :
      task.problemMatcher && typeof task.problemMatcher === "object" ? { problemMatcher: task.problemMatcher as ProblemMatcher } : {}),
    ...(typeof task.isBackground === "boolean" ? { isBackground: task.isBackground } : {}),
    ...(parsedOptions ? {
      options: {
        ...(typeof parsedOptions.cwd === "string" ? { cwd: parsedOptions.cwd } : {}),
        ...(parsedOptions.env && typeof parsedOptions.env === "object" && !Array.isArray(parsedOptions.env) ?
          { env: parsedOptions.env as Record<string, string> } : {}),
      },
    } : {}),
  };
}

function asInput(value: unknown, index: number, fileName: string): TaskInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${fileName}: input ${index + 1} must be an object`);
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || input.id.trim() === "") throw new Error(`${fileName}: input ${index + 1} needs a non-empty id`);
  if (input.type !== undefined && input.type !== "promptString" && input.type !== "pickString" && input.type !== "command") {
    throw new Error(`${fileName}: input ${input.id} type is invalid`);
  }
  if (input.options !== undefined && (!Array.isArray(input.options) || input.options.some((option) => typeof option !== "string"))) {
    throw new Error(`${fileName}: input ${input.id} options must be strings`);
  }
  return {
    id: input.id,
    ...(input.type === "promptString" || input.type === "pickString" || input.type === "command" ? { type: input.type } : {}),
    ...(typeof input.description === "string" ? { description: input.description } : {}),
    ...(typeof input.default === "string" ? { default: input.default } : {}),
    ...(Array.isArray(input.options) ? { options: input.options as string[] } : {}),
    ...(typeof input.command === "string" ? { command: input.command } : {}),
  };
}

export function validateTaskDependencies(tasks: VsTask[]): void {
  const labels = new Set<string>();
  for (const task of tasks) {
    if (labels.has(task.label)) throw new Error(`duplicate task label: ${task.label}`);
    labels.add(task.label);
  }
  for (const task of tasks) {
    for (const dependency of taskDependencies(task)) {
      if (!labels.has(dependency)) throw new Error(`task ${task.label} depends on unknown task ${dependency}`);
    }
  }
}

export function findTasksFile(startCwd: string): { workspaceCwd: string; tasksPath: string } {
  if (!isAbsolute(startCwd)) throw new Error(`workspace must be an absolute path: ${startCwd}`);
  if (!existsSync(startCwd) || !statSync(startCwd).isDirectory()) {
    throw new Error(`workspace directory does not exist: ${startCwd}`);
  }

  let current = resolve(startCwd);
  const searchedPaths: string[] = [];
  while (true) {
    if (current === "/" || current === "/home") break;
    const tasksPath = join(current, ".vscode", "tasks.json");
    searchedPaths.push(tasksPath);
    if (existsSync(tasksPath) && statSync(tasksPath).isFile()) return { workspaceCwd: current, tasksPath };
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  throw new TasksFileNotFoundError(searchedPaths);
}

export function loadTaskConfig(workspaceCwd: string): TaskConfig {
  const taskFile = findTasksFile(workspaceCwd);
  const tasksPath = taskFile.tasksPath;
  let parsed: unknown;
  try {
    parsed = parseJsonc(readFileSync(tasksPath, "utf8"), tasksPath);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${tasksPath}: root must be an object`);
  const rawTasks = (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(rawTasks)) throw new Error(`${tasksPath}: tasks must be an array`);
  const tasks = rawTasks.map((task, index) => asTask(task, index, tasksPath));
  validateTaskDependencies(tasks);
  const rawInputs = (parsed as { inputs?: unknown }).inputs;
  const inputs = rawInputs === undefined ? [] : !Array.isArray(rawInputs) ? (() => { throw new Error(`${tasksPath}: inputs must be an array`); })() : rawInputs.map((input, index) => asInput(input, index, tasksPath));
  const inputIds = new Set<string>();
  for (const input of inputs) {
    if (inputIds.has(input.id)) throw new Error(`duplicate input id: ${input.id}`);
    inputIds.add(input.id);
  }
  return { tasks, inputs, workspaceCwd: taskFile.workspaceCwd, tasksPath };
}

export function loadTasks(workspaceCwd: string): VsTask[] {
  return loadTaskConfig(workspaceCwd).tasks;
}

export function taskDependencies(task: VsTask): string[] {
  return task.dependsOn === undefined ? [] : typeof task.dependsOn === "string" ? [task.dependsOn] : task.dependsOn;
}

export function resolveTaskCwd(task: VsTask, workspaceCwd: string): string {
  const requested = task.options?.cwd?.replace(/\$\{workspaceFolder\}/g, workspaceCwd) ?? workspaceCwd;
  const taskCwd = resolve(workspaceCwd, requested);
  const outside = relative(workspaceCwd, taskCwd).startsWith("..") || isAbsolute(relative(workspaceCwd, taskCwd));
  if (outside) throw new Error(`task ${task.label} cwd must stay inside workspace: ${taskCwd}`);
  if (!existsSync(taskCwd) || !statSync(taskCwd).isDirectory()) throw new Error(`task ${task.label} cwd does not exist: ${taskCwd}`);
  return taskCwd;
}

export function resolveVariables(value: string, context: { workspaceFolder: string; inputs?: Record<string, string>; branch?: string; pane?: string; agent?: string }): string {
  return value.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    if (name === "workspaceFolder") return context.workspaceFolder;
    if (name === "gitBranch") return context.branch ?? whole;
    if (name === "herdrPane") return context.pane ?? whole;
    if (name === "herdrAgent") return context.agent ?? whole;
    if (name.startsWith("input:")) return context.inputs?.[name.slice(6)] ?? whole;
    return whole;
  });
}

export function resolveTask(task: VsTask, context: Parameters<typeof resolveVariables>[1]): VsTask {
  const resolve = (value: string) => resolveVariables(value, context);
  return {
    ...task,
    ...(task.command === undefined ? {} : { command: resolve(task.command) }),
    ...(task.args === undefined ? {} : { args: task.args.map(resolve) }),
    ...(task.script === undefined ? {} : { script: resolve(task.script) }),
    ...(task.options === undefined ? {} : {
      options: {
        ...(task.options.cwd === undefined ? {} : { cwd: resolve(task.options.cwd) }),
        ...(task.options.env === undefined ? {} : { env: Object.fromEntries(Object.entries(task.options.env).map(([key, value]) => [key, resolve(value)])) }),
      },
    }),
  };
}

export function buildCommand(task: VsTask): string[] {
  if (task.type === "npm") {
    if (!task.script) throw new Error(`task ${task.label} needs an npm script`);
    return ["npm", "run", task.script];
  }
  if (task.command) return [task.command, ...(task.args ?? [])];
  throw new Error(`task ${task.label} has no executable command`);
}

export function isCompositeTask(task: VsTask): boolean {
  return task.command === undefined && task.script === undefined && taskDependencies(task).length > 0;
}

export function resolveTasks(tasks: VsTask[]): VsTask[] {
  return tasks.filter((task) => !isCompositeTask(task));
}
