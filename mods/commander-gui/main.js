// Commander: task runner palette for Herdr (GUI mod).
// Discovers tasks beside the focused terminal's folder (.vscode/tasks.json,
// package.json, Cargo.toml, Makefile), filters as you type, then runs one in
// a new tab, a split, or the current pane (hc send). f1 opens via mod.open.
// Flow mirrors the TUI plugin 1:1: task → placement → inputs → run;
// Esc in an input cancels the whole run; an empty workspace offers to
// generate a starter .vscode/tasks.json.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, focused, theme, run, exec, hc, window as appWindow, closeOverlay, props, notify } from "herdr";
import { parseTasksJson, discoverAll, composeCommandLine, referencedInputIds, displayCommand, DEFAULT_TASKS_JSON } from "./discover.js";
import { shQuote } from "./discover.js";

const TAG_COLORS = { vscode: "ansi4", npm: "ansi1", cargo: "ansi3", make: "ansi6", init: "ansi5" };

// `${env:NAME}` references a task needs, as a batch env lookup on the target machine.
function envNamesFor(tasks) {
  const names = new Set();
  const scan = (v) => {
    if (typeof v !== "string") return;
    for (const m of v.matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(m[1]);
  };
  for (const t of tasks) {
    scan(t.command);
    (t.args ?? []).forEach(scan);
    scan(t.cwd);
    Object.values(t.env ?? {}).forEach(scan);
  }
  return [...names];
}

// ponytail: env via printenv — Windows needs powershell Env: instead; add when a Windows user asks.
async function readEnv(machine, names) {
  if (!names.length) return {};
  const r = await exec("sh", ["-c", "printenv"], { on: machine, timeout: 5000 });
  const all = {};
  for (const line of r.stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) all[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return Object.fromEntries(names.filter((n) => n in all).map((n) => [n, all[n]]));
}

export default class Commander extends View {
  init(_props, cx) {
    this.mode = "tasks"; // tasks | placement | input
    this.filter = "";
    this.at = 0;
    this.tasks = [];
    this.inputs = [];
    this.loading = true;
    this.error = null;
    this.cwd = null;
    this.machine = null;
    this.ws = null;
    this.pendingTask = null;
    this.pendingPlacement = null;
    this.inputQueue = [];
    this.inputValues = {};
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Type to filter..." });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.activate(this.pickable()[this.at], cx));
    this.discover(cx);
  }

  close() {
    closeOverlay(props().overlay);
  }

  target() {
    const f = focused();
    if (!f) return null;
    const space = spaces().find((s) => s.id === f.space);
    return { f, space, machine: space?.machine ?? null, cwd: f.cwd ?? space?.folder ?? null };
  }

  // Walk up from cwd (bounded, stopping below root) for .vscode/tasks.json —
  // the same upward search the TUI does from its workspace folder.
  async findTasksFile(cwd, machine) {
    let dir = cwd;
    for (let i = 0; i < 16 && dir; i++) {
      const r = await exec("cat", [`${dir}/.vscode/tasks.json`], { on: machine, timeout: 5000 }).catch(() => null);
      if (r && r.code === 0) return { dir, text: r.stdout };
      if (dir === "/" || dir.length <= 1) break;
      dir = dir.replace(/\/[^/]*$/, "") || "/";
    }
    return null;
  }

  async discover(cx) {
    const t = this.target();
    if (!t?.cwd) {
      this.loading = false;
      this.error = "No folder in focus: open a terminal first.";
      cx.notify();
      return;
    }
    this.cwd = t.cwd;
    this.machine = t.machine;
    try {
      const found = await this.findTasksFile(t.cwd, t.machine);
      this.ws = found?.dir ?? t.cwd;
      const read = async (name) => {
        const r = await exec("cat", [`${this.ws}/${name}`], { on: t.machine, timeout: 5000 }).catch(() => null);
        return r && r.code === 0 ? r.stdout : null;
      };
      const [tasksFile, pkg, makefile, cargo] = await Promise.all([
        found ? Promise.resolve(found.text) : Promise.resolve(null),
        read("package.json"),
        read("Makefile"),
        read("Cargo.toml"),
      ]);
      const { tasks: vscodeTasks, inputs } = tasksFile ? parseTasksJson(tasksFile, this.ws) : { tasks: [], inputs: [] };
      const labels = new Set(vscodeTasks.map((x) => x.label));
      const discovered = discoverAll(this.ws, { "package.json": pkg, Makefile: makefile, "Cargo.toml": cargo }, labels);
      this.tasks = [...vscodeTasks, ...discovered];
      this.inputs = inputs;
    } catch (e) {
      this.error = String(e);
    }
    this.loading = false;
    cx.notify();
  }

  filteredTasks() {
    // TUI searchable string: "{label} {badge} {detail-or-display_command}", lowercased substring.
    const q = this.filter.toLowerCase();
    return this.tasks.filter((t) => {
      if (!q) return true;
      const searchable = `${t.label} ${t.source} ${t.detail ?? displayCommand(t)}`.toLowerCase();
      return searchable.includes(q);
    });
  }

  // Rows per mode. Empty workspace (TUI empty state): template generator + exit.
  pickable() {
    if (this.mode === "tasks") {
      if (!this.loading && !this.tasks.length && !this.error)
        return [
          { empty: "create_template", label: "Generate template .vscode/tasks.json", detail: "Create a standard build/test configuration", source: "init" },
          { empty: "quit", label: "Exit", detail: "No tasks found in workspace" },
        ];
      return this.filteredTasks();
    }
    if (this.mode === "placement")
      // Exact TUI placement items.
      return [
        { placement: "tab", label: "Run in new tab", detail: "Create a dedicated Herdr tab" },
        { placement: "right", label: "Run in right pane", detail: "Split workspace to the right" },
        { placement: "down", label: "Run in bottom pane", detail: "Split workspace downwards" },
        { placement: "current", label: "Current pane", detail: "Send and run in active pane" },
      ];
    if (this.mode === "input") {
      const spec = this.inputs.find((i) => i.id === this.inputQueue[0]);
      if (spec?.input_type === "pickString") return spec.options.map((o) => ({ pick: o, label: o, detail: "" }));
    }
    return [];
  }

  activate(row, cx) {
    if (!row) return;
    if (this.mode === "tasks") {
      if (row.empty === "create_template") return this.generateTemplate(cx);
      if (row.empty === "quit") return this.close();
      this.pendingTask = row;
      // TUI order: placement picker first, inputs after.
      this.mode = "placement";
      this.at = 0;
      cx.notify();
      return;
    }
    if (this.mode === "placement") {
      this.pendingPlacement = row.placement;
      const needed = referencedInputIds(this.pendingTask.label, this.tasks);
      this.inputQueue = this.inputs.filter((i) => needed.has(i.id)).map((i) => i.id);
      this.inputValues = {};
      if (this.inputQueue.length) this.enterInput(cx);
      else this.launch(this.pendingPlacement, cx);
      return;
    }
    if (this.mode === "input" && row.pick !== undefined) {
      this.collectInput(row.pick, cx);
    }
  }

  // Write the TUI's starter tasks.json (POSIX machines via the core; a
  // Windows workspace keeps its empty state for now), then re-discover.
  async generateTemplate(cx) {
    const path = `${this.ws}/.vscode/tasks.json`;
    try {
      await exec("sh", ["-c", `mkdir -p ${shQuote(`${this.ws}/.vscode`)} && cat > ${shQuote(path)} <<'CMDR_EOF'\n${DEFAULT_TASKS_JSON}CMDR_EOF`], { on: this.machine, timeout: 10000 });
      this.loading = true;
      cx.notify();
      await this.discover(cx);
    } catch (e) {
      notify({ title: "Commander", body: String(e), level: "error" });
    }
  }

  enterInput(cx) {
    const spec = this.inputs.find((i) => i.id === this.inputQueue[0]);
    if (!spec) return this.launch(this.pendingPlacement, cx);
    this.mode = "input";
    this.at = 0;
    if (spec.input_type === "promptString") {
      // TUI starts the value at the input's default.
      this.promptInput = InputState.new({ placeholder: spec.default ?? "", value: spec.default ?? "" });
      this.promptInput.on("submit", (_e, cx) => this.collectInput(this.promptInput.value(), cx));
      this.promptInput.focus();
    }
    cx.notify();
  }

  collectInput(value, cx) {
    this.inputValues[this.inputQueue.shift()] = value;
    if (this.inputQueue.length) this.enterInput(cx);
    else this.launch(this.pendingPlacement, cx);
  }

  async launch(placement, cx) {
    const task = this.pendingTask;
    this.close();
    // TUI prints "Running task: <label>..." before spawning.
    notify({ title: "Commander", body: `Running task: ${task.label}...`, level: "info", timeout: 3000 });
    try {
      const env = await readEnv(this.machine, envNamesFor([task, ...taskDeps(task, this.tasks)]));
      const line = composeCommandLine(task, this.tasks, this.inputValues, env);
      if (!line) return;
      const wrap =
        appWindow().platform === "windows"
          ? ["powershell", "-NoProfile", "-Command", line]
          : ["sh", "-lc", line];
      const f = focused();
      if (placement === "tab") run("tab.new", { argv: wrap, name: task.label });
      else if (placement === "right") run("pane.split", { direction: "right", argv: wrap });
      else if (placement === "down") run("pane.split", { direction: "down", argv: wrap });
      else if (placement === "current") {
        const t = f?.terminal;
        if (!t) return notify({ title: "Commander", body: "No focused terminal to send into.", level: "warning" });
        await hc(["send", t, line]);
      }
    } catch (e) {
      notify({ title: "Commander", body: String(e), level: "error" });
    }
  }

  onKey(e, cx) {
    const k = e.key;
    const rows = this.pickable();
    if (k === "escape") {
      // TUI: Esc on the task picker quits; on placement it goes back; an
      // input or pickString cancel aborts the whole run (palette closes).
      if (this.mode === "tasks") this.close();
      else if (this.mode === "placement") {
        this.mode = "tasks";
        this.at = 0;
        this.input.focus();
      } else this.close();
    } else if (k === "down") this.at = rows.length ? (this.at + 1) % rows.length : 0;
    else if (k === "up") this.at = rows.length ? (this.at + rows.length - 1) % rows.length : 0;
    else if (k === "enter") {
      if (this.mode === "input" && !rows.length) {
        const spec = this.inputs.find((i) => i.id === this.inputQueue[0]);
        this.collectInput(spec?.default ?? "", cx);
      } else this.activate(rows[this.at], cx);
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  tag(t, source) {
    const color = t[TAG_COLORS[source] ?? "dim"] ?? t.dim;
    return div()
      .px(6)
      .py(1)
      .rounded(5)
      .text_size(10.5)
      .font_semibold()
      .text_color(color)
      .bg(t.chrome)
      .child(source);
  }

  render(cx) {
    const t = theme();
    const rows = this.pickable();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const sel = rows[this.at];
    // TUI titles: "Herdr Commander: <workspace file_name>", with a (filtered/total)
    // counter next to the filter; "Placement for: <label>"; the input's description.
    const wsName = this.ws ? (this.ws.split("/").filter(Boolean).pop() ?? this.ws) : "";
    let title;
    if (this.mode === "tasks") {
      title = `Herdr Commander: ${wsName}`;
      if (!this.loading && this.tasks.length) title += ` (${rows.length}/${this.tasks.length})`;
      else if (!this.loading && !this.tasks.length) title = "No tasks found in workspace";
    } else if (this.mode === "placement") title = `Placement for: ${this.pendingTask?.label ?? ""}`;
    else title = this.inputs.find((i) => i.id === this.inputQueue[0])?.description || this.inputQueue[0] || "";

    const header = h_flex()
      .items_center()
      .gap(8)
      .child(div().flex_1().text_size(14).font_semibold().text_color(t.foreground).truncate().child(title))
      .child(
        div()
          .id("cmdr-esc")
          .px(6)
          .py(2)
          .rounded(5)
          .text_size(11)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => this.close())
          .child("Esc"),
      );

    const filterBar =
      this.mode === "tasks" && (this.tasks.length || this.loading)
        ? h_flex()
            .h(34)
            .flex_none()
            .px(10)
            .gap(8)
            .items_center()
            .rounded(8)
            .border_1()
            .border_color(t.accent)
            .bg(t.background)
            .child(svg("mods/workspace-chrome/search.svg").size(14).text_color(t.dim))
            .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground))
        : null;

    const inputBody =
      this.mode === "input"
        ? (() => {
            const spec = this.inputs.find((i) => i.id === this.inputQueue[0]);
            if (spec?.input_type === "promptString") {
              return h_flex()
                .h(34)
                .flex_none()
                .px(10)
                .items_center()
                .rounded(8)
                .border_1()
                .border_color(t.accent)
                .bg(t.background)
                .child(Input.new(this.promptInput).flex_1().h_full().text_size(12.5).text_color(t.foreground));
            }
            return null;
          })()
        : null;

    const emptyList =
      this.mode === "tasks" && this.filter && this.tasks.length
        ? div().h(40).px(8).text_color(t.dim).text_size(12).child("No matching tasks found.")
        : null;

    const hint =
      this.mode === "tasks"
        ? "↑↓ move · Enter select · Esc close"
        : this.mode === "placement"
          ? "↑↓ move · Enter run · Esc back"
          : "Enter submit · Esc cancel";

    // The popup overlay sizes its content — there is no definite height to
    // flex against (the shipped `picker` does the same: explicit px heights,
    // never flex_1). The list gets a fixed height capped by the row count.
    const list =
      this.loading
        ? h_flex().h(120).items_center().justify_center().gap(8).child(svg("mods/workspace-chrome/spinner.svg").size(14).text_color(t.dim).spin(900)).child(div().text_color(t.muted).child("Discovering tasks…"))
        : this.error
          ? h_flex().h(120).items_center().justify_center().child(div().text_color(t.blocked).text_size(12).child(this.error))
          : !rows.length
            ? (emptyList ?? div())
            : v_flex()
                .flex_none()
                .h(Math.min(420, rows.length * 31 + 4))
                .overflow_y_scrollbar()
                .gap(1)
                .children(
                  rows.map((r, i) =>
                    h_flex()
                      .id(`cmdr-${this.mode}-${i}`)
                      .h(30)
                      .flex_none()
                      .px(8)
                      .rounded(6)
                      .gap(8)
                      .items_center()
                      .cursor_pointer()
                      .when(r === sel, (el) => el.bg(t.selected))
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, c) => this.activate(r, c))
                      .when(!!r.source, (el) => el.child(this.tag(t, r.source)))
                      .child(
                        div()
                          .flex_1()
                          .min_w(0)
                          .truncate()
                          .text_color(r === sel ? t.foreground : t.muted)
                          .child(r.label),
                      )
                      .when(!!r.detail, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).truncate().child(r.detail))),
                  ),
                );

    return v_flex()
      .id("commander-gui")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(14)
      .gap(8)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(header.flex_none())
      .when(!!filterBar, (el) => el.child(filterBar))
      .when(!!inputBody, (el) => el.child(inputBody))
      .child(list)
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(hint));
  }
}

function taskDeps(task, allTasks, seen = new Set()) {
  if (seen.has(task.label)) return [];
  seen.add(task.label);
  const byLabel = new Map(allTasks.map((x) => [x.label, x]));
  const deps = (task.depends_on ?? []).map((l) => byLabel.get(l)).filter(Boolean);
  return deps.concat(deps.flatMap((d) => taskDeps(d, allTasks, seen)));
}
