// Task discovery and command composition. Pure functions: file contents go in,
// task lists and shell lines come out. No herdr/gpui imports, no fs — I/O and
// env lookups live in main.js so this file runs unchanged under bun test.

export function stripJsoncComments(input) {
  let output = "";
  let inString = false;
  let escape = false;
  const chars = [...input];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (inString) {
      output += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      output += c;
      continue;
    }
    if (c === "/" && chars[i + 1] === "/") {
      while (i < chars.length && chars[i] !== "\n") i++;
      output += "\n";
      continue;
    }
    if (c === "/" && chars[i + 1] === "*") {
      i += 2;
      while (i < chars.length && !(chars[i - 1] === "*" && chars[i] === "/")) {
        if (chars[i] === "\n") output += "\n";
        i++;
      }
      continue;
    }
    output += c;
  }
  // trailing commas before } or ]
  return output.replace(/,(\s*[}\]])/g, "$1");
}

export function resolveVariables(value, workspaceFolder, inputs, env = {}) {
  let result = value.replaceAll("${workspaceFolder}", workspaceFolder);
  for (const [id, val] of Object.entries(inputs ?? {})) {
    result = result.replaceAll(`\${input:${id}}`, val);
  }
  result = result.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => env[name] ?? "");
  return result;
}

// Input ids referenced by root_label and its transitive depends_on tree.
export function referencedInputIds(rootLabel, tasks) {
  const map = new Map(tasks.map((t) => [t.label, t]));
  const ids = new Set();
  const seen = new Set();
  const stack = [rootLabel];
  const collectRefs = (value) => {
    const re = /\$\{input:([^}]+)\}/g;
    let m;
    while ((m = re.exec(value))) ids.add(m[1]);
  };
  while (stack.length) {
    const label = stack.pop();
    if (seen.has(label)) continue;
    seen.add(label);
    const t = map.get(label);
    if (!t) continue;
    if (t.command) collectRefs(t.command);
    (t.args ?? []).forEach(collectRefs);
    if (t.cwd) collectRefs(t.cwd);
    Object.values(t.env ?? {}).forEach(collectRefs);
    (t.depends_on ?? []).forEach((d) => stack.push(d));
  }
  return ids;
}

const shQuote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

// The command line shown as a task's detail column (TUI display_command).
export function displayCommand(task) {
  if (task.script) return `npm run ${task.script}`;
  if (task.command) return [task.command, ...(task.args ?? [])].filter(Boolean).join(" ");
  if ((task.depends_on ?? []).length) return `composite: ${(task.depends_on ?? []).join(", ")}`;
  return "no command";
}

// One task as a shell line (env prefix, cd, command). Assumes variables resolved.
// Like the TUI, the line always cds into the task's cwd (relative cwds join the
// workspace), so every placement runs from the same folder.
function taskLine(task, workspaceCwd) {
  const envPrefix = Object.entries(task.env ?? {})
    .map(([k, v]) => `${k}=${shQuote(v)}`)
    .join(" ");
  let cmd;
  if (task.script && (!task.command || task.source === "npm")) {
    cmd = `npm run ${task.script}`;
  } else if ((task.args ?? []).length) {
    // command is a program name, args are separate words.
    cmd = [task.command, ...task.args].filter(Boolean).map(shQuote).join(" ");
  } else {
    // no args: command is a raw shell line ("npm run build", "make -j4 all").
    cmd = task.command ?? "";
  }
  if (!cmd) return null;
  // cwd: absolute as-is; relative joins the workspace (TUI: workspace_cwd.join(cwd)); none → workspace.
  let cwd;
  if (!task.cwd) cwd = workspaceCwd;
  else if (task.cwd.startsWith("/") || task.cwd.startsWith("~")) cwd = task.cwd;
  else cwd = `${workspaceCwd.replace(/\/$/, "")}/${task.cwd}`;
  let line = `cd ${shQuote(cwd)} && ${cmd}`;
  if (envPrefix) line = `${envPrefix} ${line}`;
  return line;
}

// Full shell line for a task: dependencies first (sequence: && chain,
// parallel: backgrounded + wait), then the task itself.
export function composeCommandLine(task, allTasks, resolvedInputs, env = {}) {
  const resolveTask = (t) => ({
    ...t,
    command: t.command && resolveVariables(t.command, t._ws, resolvedInputs, env),
    args: (t.args ?? []).map((a) => resolveVariables(a, t._ws, resolvedInputs, env)),
    cwd: t.cwd && resolveVariables(t.cwd, t._ws, resolvedInputs, env),
    env: Object.fromEntries(Object.entries(t.env ?? {}).map(([k, v]) => [k, resolveVariables(v, t._ws, resolvedInputs, env)])),
  });
  const byLabel = new Map(allTasks.map((t) => [t.label, t]));
  const walk = (label, seen = new Set()) => {
    if (seen.has(label)) return [];
    seen.add(label);
    const t = byLabel.get(label);
    if (!t) return [];
    const lines = (t.depends_on ?? []).flatMap((d) => walk(d, seen));
    const line = taskLine(resolveTask(t), t._ws);
    if (line) lines.push(line);
    return lines;
  };
  const lines = (task.depends_on ?? []).flatMap((d) => walk(d));
  const own = taskLine(resolveTask(task), task._ws);
  if (own) lines.push(own);
  if (!lines.length) return null;
  if (lines.length === 1) return lines[0];
  if (task.depends_order === "parallel") return `${lines.join(" & ")} & wait`;
  return lines.join(" && ");
}

// Same default template the TUI writes from its empty state.
export const DEFAULT_TASKS_JSON = `{
    "version": "2.0.0",
    "tasks": [
        {
            "label": "Build project",
            "type": "shell",
            "command": "echo 'Building...'",
            "group": {
                "kind": "build",
                "isDefault": true
            }
        },
        {
            "label": "Test project",
            "type": "shell",
            "command": "echo 'Testing...'",
            "group": {
                "kind": "test",
                "isDefault": true
            }
        }
    ]
}
`;

// .vscode/tasks.json (JSONC) → {tasks, inputs}
export function parseTasksJson(text, workspaceCwd) {
  let raw;
  try {
    raw = JSON.parse(stripJsoncComments(text));
  } catch {
    return { tasks: [], inputs: [] };
  }
  const tasks = (raw.tasks ?? []).map((r) => ({
    label: r.label,
    task_type: r.type ?? null,
    source: "vscode",
    command: r.command ?? null,
    args: Array.isArray(r.args) ? r.args : [],
    script: r.script ?? null,
    cwd: r.options?.cwd ?? null,
    env: r.options?.env ?? {},
    depends_on: typeof r.dependsOn === "string" ? [r.dependsOn] : (r.dependsOn ?? []),
    depends_order: r.dependsOrder === "parallel" ? "parallel" : "sequence",
    detail: r.detail ?? null,
    _ws: workspaceCwd,
  }));
  const inputs = (raw.inputs ?? []).map((i) => ({
    id: i.id,
    input_type: i.type === "pickString" ? "pickString" : "promptString",
    description: i.description ?? null,
    default: i.default ?? null,
    options: i.options ?? [],
  }));
  return { tasks, inputs };
}

// Discovered tasks from sibling files of the workspace. `files`:
// { "package.json": text?, "Makefile": text?, "Cargo.toml": text? } (missing key = no file).
export function discoverAll(workspaceCwd, files, existingLabels = new Set()) {
  const out = [];
  const ws = workspaceCwd;
  const push = (t) => {
    if (!existingLabels.has(t.label)) out.push(t);
  };

  const pkgText = files["package.json"];
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText);
      const scripts = Object.entries(pkg.scripts ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
      for (const [name, scriptCmd] of scripts) {
        push({
          label: `npm: ${name}`,
          task_type: "npm",
          source: "npm",
          command: "npm",
          args: ["run", name],
          script: name,
          cwd: null,
          env: {},
          depends_on: [],
          depends_order: "sequence",
          detail: scriptCmd,
          _ws: ws,
        });
      }
    } catch {}
  }

  if (files["Cargo.toml"]) {
    for (const [label, ...args] of [
      ["cargo: check", "check"],
      ["cargo: test", "test"],
      ["cargo: build", "build"],
      ["cargo: build --release", "build", "--release"],
      ["cargo: clippy", "clippy"],
    ]) {
      push({
        label,
        task_type: "cargo",
        source: "cargo",
        command: "cargo",
        args,
        script: null,
        cwd: null,
        env: {},
        depends_on: [],
        depends_order: "sequence",
        detail: null,
        _ws: ws,
      });
    }
  }

  const makeText = files["Makefile"];
  if (makeText) {
    const seen = new Set();
    for (const rawLine of makeText.split("\n")) {
      // Skip recipe lines (tab-indented), variable assignments and comments.
      if (rawLine.startsWith("\t")) continue;
      const colon = rawLine.indexOf(":");
      if (colon < 0) continue;
      const target = rawLine.slice(0, colon).trim();
      // `VAR:=value` / `VAR?=value`: = right after the colon is an assignment.
      if (
        !target ||
        rawLine[colon + 1] === "=" ||
        target.startsWith(".") ||
        target.startsWith("#") ||
        target.includes("=") ||
        target.includes("%") ||
        seen.has(target)
      )
        continue;
      seen.add(target);
      push({
        label: `make: ${target}`,
        task_type: "make",
        source: "make",
        command: "make",
        args: [target],
        script: null,
        cwd: null,
        env: {},
        depends_on: [],
        depends_order: "sequence",
        detail: null,
        _ws: ws,
      });
    }
  }
  return out;
}

// Input ids a task needs values for before it can run.
export { shQuote };
