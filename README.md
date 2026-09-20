# herdr-commander

> Universal task runner, command palette and build orchestrator for [Herdr](https://herdr.dev).

`herdr-commander` gives Herdr a unified command launcher with zero runtime dependencies. It automatically discovers, filters, and runs tasks from your workspace across tabs, split panes, or the active terminal.

---

## Key Features

- **Zero-Toolchain Runtime**: Native standalone binary in Rust (~1.5 MB). No Node.js, npm, or tsx required.
- **Instant Launcher (<10ms)**: Transient session popup powered by `ratatui` and `crossterm`.
- **Unified Autodiscovery**: Automatically extracts commands from:
  - `.vscode/tasks.json` (full tasks, variable expansion, sequential/parallel dependencies)
  - `package.json` (npm/yarn/pnpm scripts)
  - `Cargo.toml` (cargo build, test, check, clippy)
  - `Makefile` (all declared targets)
- **Interactive Inputs**: Full support for VS Code dynamic inputs (`promptString` and `pickString`).
- **Flexible Target Placements**:
  - **New Tab**: Dedicated Herdr workspace tab.
  - **Right Split**: Side-by-side terminal.
  - **Bottom Split**: Lower terminal panel.
  - **Current Pane**: Injected directly into active terminal.
- **Atomic Process Control**: Supervised process groups (`PGID`). Cancelling or aborting (`Ctrl+C`) cleanly terminates all parallel child processes without leaving orphans.

---

## Visual Overview

### 1. Task Launcher & Autodiscovery
```text
┌ Herdr Commander: api-service (6/6) ────────────────────────────────────────────────────────┐
│ Filter: Type to filter...                                                                  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌ Commands ──────────────────────────────────────────────────────────────────────────────────┐
│ ▶ [cargo] cargo: check                               · cargo check                         │
│   [cargo] cargo: test                                · cargo test                          │
│   [vscode] Verify project                            · composite: cargo: check, cargo: test│
│   [npm] npm: build                                   · vite build                          │
│   [npm] npm: lint                                    · biome check src                     │
│   [make] make: docker-up                             · docker compose up -d                │
└────────────────────────────────────────────────────────────────────────────────────────────┘
 ↑↓/j/k move · Enter select · Esc/q quit
```

### 2. Flexible Pane Placement Selection
```text
┌ Placement for: cargo: check (4/4) ─────────────────────────────────────────────────────────┐
│ Filter: Type to filter...                                                                  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌ Commands ──────────────────────────────────────────────────────────────────────────────────┐
│ ▶ [tab] Run in new tab                               · Create a dedicated Herdr tab        │
│   [split] Run in right pane                          · Split workspace to the right        │
│   [split] Run in bottom pane                         · Split workspace downwards           │
│   [current] Current pane                             · Send and run in active pane         │
└────────────────────────────────────────────────────────────────────────────────────────────┘
 ↑↓/j/k move · Enter select · Esc back
```

### 3. Interactive Input Prompt (`promptString`)
```text
┌─ Input: Target Environment ──────────────────────────────┐
│ Value: staging█                                          │
│                                                          │
│ Enter submit · Esc cancel                                │
└──────────────────────────────────────────────────────────┘
```

---

## Installation

Install directly via the Herdr plugin manager:

```bash
herdr plugin install lurepos/herdr-commander
```

Verify installation:

```bash
herdr plugin list
```

---

## Keybinding Setup

Bind Commander to your preferred shortcut (e.g. `F1`) in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "f1"
type = "plugin_action"
command = "herdr.commander.open-picker"
description = "Open Herdr Commander"
```

Reload Herdr configuration without restarting your session:

```bash
herdr server reload-config
```

---

## Usage

1. Press **`F1`** anywhere in Herdr to open the Commander popup.
2. **Type to filter**: Substring matching across task labels, origin tags, and command contents.
3. **Navigate**:
   - `↑` / `↓` or `k` / `j` to move selection.
   - `Enter` to select task.
   - `Esc` or `q` to dismiss or go back.
4. Choose **Placement** (`Run in new tab`, `Run in right pane`, `Run in bottom pane`, `Current pane`).

---

## Local Development

```bash
# Run test suite
cargo test

# Build optimized release binary
cargo build --release

# Link working directory into local Herdr installation
herdr plugin link .
```
