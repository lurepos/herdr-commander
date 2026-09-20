use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use serde_json::Value;

use crate::config::{DependsOrder, Task};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    Tab,
    Right,
    Down,
    Current,
}

impl Placement {
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Tab => "tab",
            Self::Right => "right",
            Self::Down => "down",
            Self::Current => "current",
        }
    }
}

pub struct ProcessRegistry {
    pids: Mutex<Vec<u32>>,
    cancelled: AtomicBool,
}

impl ProcessRegistry {
    pub fn new() -> Self {
        Self {
            pids: Mutex::new(Vec::new()),
            cancelled: AtomicBool::new(false),
        }
    }

    pub fn register(&self, pid: u32) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err("Cancelled".to_string());
        }
        let mut pids = self.pids.lock().unwrap();
        pids.push(pid);
        Ok(())
    }

    pub fn unregister(&self, pid: u32) {
        let mut pids = self.pids.lock().unwrap();
        pids.retain(|&p| p != pid);
    }

    pub fn cancel_all(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let pids = {
            let mut pids = self.pids.lock().unwrap();
            let copy = pids.clone();
            pids.clear();
            copy
        };

        for pid in pids {
            #[cfg(unix)]
            unsafe {
                // Send SIGTERM to process group
                libc::kill(-(pid as i32), libc::SIGTERM);
                libc::kill(pid as i32, libc::SIGTERM);
            }
            #[cfg(not(unix))]
            {
                // Fallback for non-unix
                let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
            }
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

pub struct HerdrClient {
    bin_path: String,
}

impl HerdrClient {
    pub fn new() -> Self {
        let bin_path = std::env::var("HERDR_BIN_PATH").unwrap_or_else(|_| "herdr".to_string());
        Self { bin_path }
    }

    pub fn pane_current(&self) -> Result<String, String> {
        let output = Command::new(&self.bin_path)
            .args(["pane", "current"])
            .output()
            .map_err(|e| format!("Failed to call herdr pane current: {e}"))?;

        if !output.status.success() {
            return Err(format!(
                "herdr pane current failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }

        let json_str = String::from_utf8_lossy(&output.stdout);
        let val: Value = serde_json::from_str(&json_str)
            .map_err(|e| format!("Invalid JSON from herdr pane current: {e}"))?;

        let pane_id = val["result"]["pane"]["pane_id"]
            .as_str()
            .or_else(|| val["result"]["pane_id"].as_str())
            .ok_or_else(|| "herdr pane current returned no pane_id".to_string())?;

        Ok(pane_id.to_string())
    }

    pub fn current_pane_cwd(&self) -> Option<PathBuf> {
        let output = Command::new(&self.bin_path)
            .args(["pane", "current"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let val: Value = serde_json::from_slice(&output.stdout).ok()?;
        let cwd_str = val["result"]["pane"]["cwd"]
            .as_str()
            .or_else(|| val["result"]["pane"]["foreground_cwd"].as_str())?;
        Some(PathBuf::from(cwd_str))
    }

    pub fn create_pane(
        &self,
        placement: Placement,
        cwd: &Path,
        label: &str,
        env: &HashMap<String, String>,
    ) -> Result<String, String> {
        let cwd_str = cwd.to_string_lossy();
        let mut cmd = Command::new(&self.bin_path);

        match placement {
            Placement::Current => return self.pane_current(),
            Placement::Tab => {
                cmd.args(["tab", "create", "--cwd", &cwd_str, "--label", label, "--focus"]);
            }
            Placement::Right => {
                cmd.args(["pane", "split", "--direction", "right", "--cwd", &cwd_str, "--focus"]);
            }
            Placement::Down => {
                cmd.args(["pane", "split", "--direction", "down", "--cwd", &cwd_str, "--focus"]);
            }
        }

        for (k, v) in env {
            cmd.args(["--env", &format!("{k}={v}")]);
        }

        let output = cmd.output().map_err(|e| format!("Failed to create pane in Herdr: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "Failed to create Herdr pane: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }

        let json_str = String::from_utf8_lossy(&output.stdout);
        let val: Value = serde_json::from_str(&json_str)
            .map_err(|e| format!("Invalid JSON from herdr create pane: {e}"))?;

        let pane_id = val["result"]["root_pane"]["pane_id"]
            .as_str()
            .or_else(|| val["result"]["pane"]["pane_id"].as_str())
            .or_else(|| val["result"]["pane_id"].as_str())
            .ok_or_else(|| "Herdr returned no pane id".to_string())?;

        Ok(pane_id.to_string())
    }

    pub fn send_text_to_pane(&self, pane_id: &str, text: &str) -> Result<(), String> {
        let status = Command::new(&self.bin_path)
            .args(["pane", "send-text", pane_id, text])
            .status()
            .map_err(|e| format!("Failed to send text to pane {pane_id}: {e}"))?;

        if !status.success() {
            return Err(format!("send-text to pane {pane_id} failed"));
        }

        let status_enter = Command::new(&self.bin_path)
            .args(["pane", "send-keys", pane_id, "Enter"])
            .status()
            .map_err(|e| format!("Failed to send Enter to pane {pane_id}: {e}"))?;

        if !status_enter.success() {
            return Err(format!("send-keys to pane {pane_id} failed"));
        }

        Ok(())
    }

    pub fn spawn_pane_run(
        &self,
        pane_id: &str,
        command_args: &[String],
        registry: &Arc<ProcessRegistry>,
    ) -> Result<Child, String> {
        let mut cmd = Command::new(&self.bin_path);
        cmd.args(["pane", "run", pane_id]);
        cmd.args(command_args);
        cmd.stdout(Stdio::inherit());
        cmd.stderr(Stdio::inherit());

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn herdr pane run: {e}"))?;

        let pid = child.id();
        registry.register(pid)?;

        Ok(child)
    }
}

pub fn resolve_task_command(task: &Task) -> Result<Vec<String>, String> {
    if let Some(ref script) = task.script {
        return Ok(vec!["npm".to_string(), "run".to_string(), script.clone()]);
    }

    if let Some(ref cmd) = task.command {
        let mut parts = vec![cmd.clone()];
        parts.extend(task.args.clone());
        return Ok(parts);
    }

    if !task.depends_on.is_empty() {
        return Ok(Vec::new()); // Composite task
    }

    Err(format!("Task '{}' has no executable command", task.label))
}

pub fn execute_task_tree(
    target_task: &Task,
    all_tasks: &[Task],
    workspace_cwd: &Path,
    placement: Placement,
    registry: Arc<ProcessRegistry>,
    client: Arc<HerdrClient>,
) -> Result<(), String> {
    let task_map: HashMap<String, &Task> = all_tasks.iter().map(|t| (t.label.clone(), t)).collect();

    // Check for dependency cycles
    let mut visiting = HashSet::new();
    fn check_cycle(task_label: &str, map: &HashMap<String, &Task>, visiting: &mut HashSet<String>) -> Result<(), String> {
        if visiting.contains(task_label) {
            return Err(format!("Dependency cycle detected including task: '{task_label}'"));
        }
        visiting.insert(task_label.to_string());
        if let Some(task) = map.get(task_label) {
            for dep in &task.depends_on {
                check_cycle(dep, map, visiting)?;
            }
        }
        visiting.remove(task_label);
        Ok(())
    }
    check_cycle(&target_task.label, &task_map, &mut visiting)?;

    // Execution helper
    fn run_recursive(
        task: &Task,
        map: &HashMap<String, &Task>,
        workspace_cwd: &Path,
        placement: Placement,
        registry: Arc<ProcessRegistry>,
        client: Arc<HerdrClient>,
    ) -> Result<(), String> {
        if registry.is_cancelled() {
            return Err("Cancelled by user".to_string());
        }

        // Execute dependencies first
        if !task.depends_on.is_empty() {
            match task.depends_order {
                DependsOrder::Sequence => {
                    for dep_label in &task.depends_on {
                        let dep_task = map.get(dep_label).ok_or_else(|| {
                            format!("Task '{}' depends on unknown task '{dep_label}'", task.label)
                        })?;
                        run_recursive(dep_task, map, workspace_cwd, placement, registry.clone(), client.clone())?;
                    }
                }
                DependsOrder::Parallel => {
                    thread::scope(|s| {
                        let mut handles = Vec::new();
                        for dep_label in &task.depends_on {
                            let dep_task = *map.get(dep_label).ok_or_else(|| {
                                format!("Task '{}' depends on unknown task '{dep_label}'", task.label)
                            })?;
                            let reg_clone = registry.clone();
                            let cli_clone = client.clone();

                            let handle = s.spawn(move || {
                                run_recursive(dep_task, map, workspace_cwd, placement, reg_clone, cli_clone)
                            });
                            handles.push(handle);
                        }

                        for handle in handles {
                            let res = handle.join().map_err(|_| "Thread panic during parallel task".to_string())?;
                            res?;
                        }
                        Ok::<(), String>(())
                    })?;
                }
            }
        }

        let cmd_parts = resolve_task_command(task)?;
        if cmd_parts.is_empty() {
            // Composite task: nothing to run itself
            return Ok(());
        }

        let task_cwd = if let Some(ref cwd) = task.cwd {
            workspace_cwd.join(cwd)
        } else {
            workspace_cwd.to_path_buf()
        };

        if placement == Placement::Current {
            let pane_id = client.pane_current()?;
            let full_cmd = cmd_parts.join(" ");
            let line = format!("cd '{}' && {}", task_cwd.display(), full_cmd);
            client.send_text_to_pane(&pane_id, &line)?;
            return Ok(());
        }

        let pane_id = client.create_pane(placement, &task_cwd, &task.label, &task.env)?;
        let mut child = client.spawn_pane_run(&pane_id, &cmd_parts, &registry)?;
        let pid = child.id();

        let status = child
            .wait()
            .map_err(|e| format!("Failed waiting for task '{}': {e}", task.label))?;

        registry.unregister(pid);

        if !status.success() {
            return Err(format!(
                "Task '{}' exited with status: {}",
                task.label,
                status.code().map(|c| c.to_string()).unwrap_or_else(|| "terminated".to_string())
            ));
        }

        Ok(())
    }

    run_recursive(
        target_task,
        &task_map,
        workspace_cwd,
        placement,
        registry,
        client,
    )
}
