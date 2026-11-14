import { describe, test, expect } from "bun:test";
import { stripJsoncComments, resolveVariables, referencedInputIds, parseTasksJson, discoverAll, composeCommandLine } from "./discover.js";

describe("stripJsoncComments", () => {
  test("line, block and trailing comments", () => {
    const jsonc = `{
        // Line comment
        "tasks": [
            {
                "label": "test", /* inline block */
                "command": "echo https://example.com", // trailing
            },
        ],
    }`;
    const parsed = JSON.parse(stripJsoncComments(jsonc));
    expect(parsed.tasks[0].label).toBe("test");
    expect(parsed.tasks[0].command).toBe("echo https://example.com");
  });
});

describe("resolveVariables", () => {
  test("workspace, env and input", () => {
    const resolved = resolveVariables(
      "${workspaceFolder}/build/${env:HERDR_TEST_VAR}/${input:target}",
      "/my/project",
      { target: "prod" },
      { HERDR_TEST_VAR: "foo" }
    );
    expect(resolved).toBe("/my/project/build/foo/prod");
  });
  test("missing env becomes empty", () => {
    expect(resolveVariables("x${env:NOPE}y", "/w", {}, {})).toBe("xy");
  });
});

describe("referencedInputIds", () => {
  test("walks depends_on transitively", () => {
    const mk = (label, deps, env) => ({
      label,
      command: "echo",
      args: [],
      cwd: null,
      env: env ?? {},
      depends_on: deps,
    });
    const tasks = [mk("E2E", ["ADB"], { E2E_MODEL: "${input:model}" }), mk("ADB", []), mk("Unrelated", [])];
    const ids = referencedInputIds("E2E", tasks);
    expect(ids.has("model")).toBe(true);
    expect(ids.size).toBe(1);
  });
});

describe("parseTasksJson", () => {
  test("parses dependsOn single and list, options, inputs", () => {
    const text = `{
      "version": "2.0.0",
      "tasks": [
        {"label": "Build", "type": "shell", "command": "npm run build",
         "options": {"cwd": "\${workspaceFolder}/apps/web", "env": {"MODE": "debug"}}},
        {"label": "Test", "command": "npm test", "dependsOn": "Build"},
        {"label": "All", "command": "make", "args": ["all"], "dependsOn": ["Build", "Test"], "dependsOrder": "parallel"}
      ],
      "inputs": [
        {"id": "env", "type": "pickString", "options": ["staging", "prod"], "default": "staging"},
        {"id": "name", "type": "promptString", "description": "your name"}
      ]
    }`;
    const { tasks, inputs } = parseTasksJson(text, "/repo");
    expect(tasks).toHaveLength(3);
    expect(tasks[0].cwd).toBe("${workspaceFolder}/apps/web");
    expect(tasks[0].env.MODE).toBe("debug");
    expect(tasks[1].depends_on).toEqual(["Build"]);
    expect(tasks[2].depends_on).toEqual(["Build", "Test"]);
    expect(tasks[2].depends_order).toBe("parallel");
    expect(inputs[0].input_type).toBe("pickString");
    expect(inputs[0].options).toEqual(["staging", "prod"]);
    expect(inputs[1].input_type).toBe("promptString");
  });
  test("invalid JSON returns empty", () => {
    expect(parseTasksJson("{not json", "/r")).toEqual({ tasks: [], inputs: [] });
  });
});

describe("discoverAll", () => {
  test("npm scripts sorted, cargo presets, makefile targets", () => {
    const files = {
      "package.json": JSON.stringify({ scripts: { zebra: "z", alpha: "a" } }),
      "Cargo.toml": "[package]\nname = 'x'\n",
      Makefile: ".PHONY: build test\nbuild:deps\n\t@echo should-not-appear: as-target\ndeps:\nVAR:=1\n",
    };
    const tasks = discoverAll("/w", files);
    const labels = tasks.map((t) => t.label);
    expect(labels).toContain("npm: alpha");
    expect(labels.indexOf("npm: alpha")).toBeLessThan(labels.indexOf("npm: zebra"));
    expect(labels).toContain("cargo: check");
    expect(labels).toContain("cargo: build --release");
    expect(labels).toContain("make: build");
    expect(labels).toContain("make: deps");
    expect(labels).not.toContain("make: .PHONY");
    expect(labels).not.toContain("make: VAR");
    expect(labels.some((l) => l.includes("echo"))).toBe(false);
    const makeBuild = tasks.find((t) => t.label === "make: build");
    expect(makeBuild.args).toEqual(["build"]);
  });
  test("respects existing labels (vscode wins)", () => {
    const tasks = discoverAll("/w", { "package.json": '{"scripts":{"build":"x"}}' }, new Set(["npm: build"]));
    expect(tasks.find((t) => t.label === "npm: build")).toBeUndefined();
  });
});

describe("composeCommandLine", () => {
  const base = { cwd: null, env: {}, args: [], script: null, _ws: "/repo" };
  test("simple task", () => {
    const t = { ...base, label: "T", command: "cargo", args: ["test"] };
    expect(composeCommandLine(t, [t], {})).toBe(`cd '/repo' && 'cargo' 'test'`);
  });
  test("npm script", () => {
    const t = { ...base, label: "npm: build", source: "npm", command: "npm", args: ["run", "build"], script: "build" };
    expect(composeCommandLine(t, [t], {})).toBe(`cd '/repo' && npm run build`);
  });
  test("env prefix, cwd and variable resolution", () => {
    const t = {
      ...base,
      label: "T",
      command: "pnpm exec e2e",
      cwd: "${workspaceFolder}/apps/web",
      env: { MODE: "${input:mode}", HOME_DIR: "${env:HERDR_TEST_JH}" },
    };
    const line = composeCommandLine(t, [t], { mode: "debug" }, { HERDR_TEST_JH: "/usr/lib/jvm" });
    expect(line).toContain(`cd '/repo/apps/web'`);
    expect(line).toContain(`MODE='debug'`);
    expect(line).toContain(`HOME_DIR='/usr/lib/jvm'`);
    expect(line).toContain(`pnpm exec e2e`);
  });
  test("sequential deps chain with &&", () => {
    const build = { ...base, label: "Build", command: "npm run build" };
    const testT = { ...base, label: "Test", command: "npm test", depends_on: ["Build"] };
    const line = composeCommandLine(testT, [build, testT], {});
    expect(line).toBe(`cd '/repo' && npm run build && cd '/repo' && npm test`);
  });
  test("parallel deps background + wait", () => {
    const a = { ...base, label: "A", command: "a" };
    const b = { ...base, label: "B", command: "b" };
    const all = { ...base, label: "All", command: "echo done", depends_on: ["A", "B"], depends_order: "parallel" };
    const line = composeCommandLine(all, [a, b, all], {});
    expect(line).toBe(`cd '/repo' && a & cd '/repo' && b & cd '/repo' && echo done & wait`);
  });
  test("relative cwd joins workspace", () => {
    const t = { ...base, label: "T", command: "make", args: ["all"], cwd: "apps/web" };
    expect(composeCommandLine(t, [t], {})).toBe(`cd '/repo/apps/web' && 'make' 'all'`);
  });
  test("single quotes in args are escaped", () => {
    const t = { ...base, label: "T", command: "echo", args: ["it's"] };
    expect(composeCommandLine(t, [t], {})).toBe(`cd '/repo' && 'echo' 'it'\\''s'`);
  });
});
