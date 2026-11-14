// Cross-check: the GUI mod's discovery pipeline must produce the same task
// list as the TUI binary's discovery (src/discovery.rs + src/config.rs) on
// the same fixture tree. The Rust side is read via the hidden
// `herdr-commander --dump-tasks <dir>` flag (JSON). Deliberate divergences
// (tolerant args, 16-level walk cap) are documented in README.md, not hidden.
import { describe, test, expect } from "bun:test";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseTasksJson, discoverAll } from "./discover.js";

const FIXTURES = ["/tmp/opencode/parity-fixture", "demo/orders-api", "demo/platform"];
const BIN = new URL("../../target/debug/herdr-commander", import.meta.url).pathname;

function rustTasks(fixture) {
  const out = execSync(`${BIN} --dump-tasks ${fixture}`, { encoding: "utf8" });
  return JSON.parse(out);
}

// Same pipeline main.js runs: tasks.json + sibling discovery, vscode labels win.
function jsTasks(fixture) {
  const ws = fixture;
  const read = (p) => {
    try {
      return readFileSync(`${ws}/${p}`, "utf8");
    } catch {
      return null;
    }
  };
  const tasksFile = read(".vscode/tasks.json");
  const { tasks: vscodeTasks, inputs } = tasksFile ? parseTasksJson(tasksFile, ws) : { tasks: [], inputs: [] };
  const labels = new Set(vscodeTasks.map((t) => t.label));
  const discovered = discoverAll(ws, { "package.json": read("package.json"), Makefile: read("Makefile"), "Cargo.toml": read("Cargo.toml") }, labels);
  const all = [...vscodeTasks, ...discovered];
  return {
    workspace: ws,
    tasks: all.map((t) => ({
      label: t.label,
      source: t.source,
      command: t.command,
      args: t.args,
      script: t.script ?? null,
      detail: t.detail ?? null,
      cwd: t.cwd ?? null,
      depends_on: t.depends_on,
      depends_order: t.depends_order,
    })),
    inputs,
  };
}

describe.each(FIXTURES)("discovery parity: %s", (fixture) => {
  const rust = rustTasks(fixture);
  const js = jsTasks(fixture);

  test("same workspace resolution", () => {
    expect(js.workspace).toBe(rust.workspace);
  });

  test("same task list (labels, order, commands, args, detail, deps)", () => {
    expect(js.tasks).toEqual(rust.tasks);
  });
});
