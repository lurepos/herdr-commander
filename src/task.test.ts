import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCommand, findTasksFile, isCompositeTask, parseJsonc, resolveTask, resolveVariables, taskDependencies, type VsTask } from "./task.js";
import { parseProblems } from "./problems.js";
import { executeTask, type Placement } from "./runner.js";

test("parses JSONC without removing URL contents", () => {
  assert.deepEqual(parseJsonc(`{
    "tasks": [{ "label": "x", "command": "echo https://example.com", }],
  }`), {
    tasks: [{ label: "x", command: "echo https://example.com" }],
  });
});

test("builds supported commands", () => {
  assert.deepEqual(buildCommand({ label: "npm", type: "npm", script: "test" }), ["npm", "run", "test"]);
  assert.deepEqual(buildCommand({ label: "shell", type: "shell", command: "echo", args: ["Hello World"] }), ["echo", "Hello World"]);
});

test("normalizes dependencies and composite tasks", () => {
  const task: VsTask = { label: "verify", type: "shell", command: "true", dependsOn: ["build", "lint"] };
  assert.deepEqual(taskDependencies(task), ["build", "lint"]);
  assert.equal(isCompositeTask({ label: "all", dependsOn: ["build"] }), true);
});

test("resolves workspace, input, branch, pane, and agent variables", () => {
  const variable = (name: string) => ["$", "{", name, "}"].join("");
  const value = resolveVariables(["workspaceFolder", "input:name", "gitBranch", "herdrPane", "herdrAgent"].map(variable).join("/"), {
    workspaceFolder: "/workspace",
    inputs: { name: "api" },
    branch: "main",
    pane: "p1",
    agent: "reviewer",
  });
  assert.equal(value, "/workspace/api/main/p1/reviewer");
  assert.deepEqual(resolveTask({ label: "x", command: "echo", args: ["$" + "{input:name}"] }, { workspaceFolder: "/workspace", inputs: { name: "api" } }).args, ["api"]);
});

test("parses and deduplicates problem matcher output", () => {
  const problems = parseProblems("src/app.ts(4,2): error TS2322: bad\nsrc/app.ts(4,2): error TS2322: bad", "$tsc", { workspaceCwd: "/workspace", taskLabel: "check" });
  assert.deepEqual(problems, [{ owner: "typescript", source: "ts", file: "/workspace/src/app.ts", line: 4, column: 2, severity: "error", code: "TS2322", message: "bad" }]);
});

test("finds tasks.json in the nearest parent and prefers the current directory", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-tasks-"));
  const parent = join(root, "project");
  const child = join(parent, "packages", "api");
  mkdirSync(join(parent, ".vscode"), { recursive: true });
  mkdirSync(child, { recursive: true });
  const parentTasks = join(parent, ".vscode", "tasks.json");
  writeFileSync(parentTasks, "{}");

  assert.deepEqual(findTasksFile(child), { workspaceCwd: parent, tasksPath: parentTasks });

  const childTasks = join(child, ".vscode", "tasks.json");
  mkdirSync(join(child, ".vscode"));
  writeFileSync(childTasks, "{}");
  assert.deepEqual(findTasksFile(child), { workspaceCwd: child, tasksPath: childTasks });
});

test("supports current pane placement", () => {
  const placement: Placement = "current";
  assert.equal(placement, "current");
});

test("runs composite dependencies without creating a pane for the group", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-runner-"));
  const herdrPath = join(root, "herdr");
  writeFileSync(herdrPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.argv[1] + ".log", process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "tab" && process.argv[3] === "create") {
  process.stdout.write(JSON.stringify({ result: { root_pane: { pane_id: "p1" } } }));
}
`);
  chmodSync(herdrPath, 0o755);
  const controller = new AbortController();
  const tasks: VsTask[] = [
    { label: "build", type: "shell", command: "true" },
    { label: "group", dependsOn: "build" },
    { label: "verify", type: "shell", command: "true", dependsOn: "group" },
  ];
  const verifyTask = tasks.find((candidate) => candidate.label === "verify");
  assert.ok(verifyTask);

  const results = await executeTask(verifyTask, tasks, {
    workspaceCwd: root,
    placement: "tab",
    herdr: herdrPath,
    signal: controller.signal,
    onStateChange: () => undefined,
    onOutput: () => undefined,
  });

  const calls = readFileSync(`${herdrPath}.log`, "utf8").trim().split(/\r?\n/);
  assert.deepEqual(calls.filter((call) => call.startsWith("tab create")).map((call) => call.match(/--label ([^ ]+)/)?.[1]), ["build", "verify"]);
  assert.equal(calls.some((call) => call.includes("--label group")), false);
  assert.deepEqual(results.map((result) => result.task), ["build", "verify"]);
  assert.equal(results.at(-1)?.state, "succeeded");
});
