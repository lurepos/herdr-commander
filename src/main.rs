mod config;
mod discovery;
mod runner;
mod ui;

use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::Arc;

use config::{InputType, Task};
use discovery::{create_default_tasks_json, discover_all_tasks};
use runner::{execute_task_tree, HerdrClient, ProcessRegistry};
use ui::{
    placement_picker_items, prompt_string, run_picker, task_to_picker_item,
    PickerItem, PickerResult, TerminalGuard,
};

fn resolve_workspace_dir(client: &HerdrClient) -> PathBuf {
    if let Ok(cwd) = env::var("HERDR_WORKSPACE_CWD") {
        if !cwd.is_empty() {
            return PathBuf::from(cwd);
        }
    }
    if let Ok(cwd) = env::var("HERDR_PANE_CWD") {
        if !cwd.is_empty() {
            return PathBuf::from(cwd);
        }
    }
    if let Some(cwd) = client.current_pane_cwd() {
        return cwd;
    }
    env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Arc::new(HerdrClient::new());
    let registry = Arc::new(ProcessRegistry::new());

    // Register signal handlers for clean atomic termination
    let reg_sig = registry.clone();
    ctrlc_handler(reg_sig);

    let workspace_dir = resolve_workspace_dir(&client);
    let (_ws, mut config) = discover_all_tasks(&workspace_dir);

    // RAII Terminal initialization
    let mut guard = TerminalGuard::new()?;

    // Empty state handling (rule/empty-state-action)
    if config.tasks.is_empty() {
        let empty_items = vec![
            PickerItem {
                value: "create_template",
                label: "Generate template .vscode/tasks.json".to_string(),
                detail: Some("Create a standard build/test configuration".to_string()),
                badge: Some("init".to_string()),
                searchable: "generate create template init tasks.json".to_string(),
            },
            PickerItem {
                value: "quit",
                label: "Exit".to_string(),
                detail: Some("No tasks found in workspace".to_string()),
                badge: None,
                searchable: "exit quit".to_string(),
            },
        ];

        match run_picker(&mut guard.terminal, "No tasks found in workspace", &empty_items, false)? {
            PickerResult::Selected("create_template") => {
                let _ = create_default_tasks_json(&workspace_dir);
                let (_, reloaded) = discover_all_tasks(&workspace_dir);
                config = reloaded;
            }
            _ => return Ok(()),
        }
    }

    if config.tasks.is_empty() {
        return Ok(());
    }

    let workspace_name = workspace_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workspace");

    loop {
        let task_items: Vec<PickerItem<Task>> = config.tasks.iter().map(task_to_picker_item).collect();
        let task_result = run_picker(
            &mut guard.terminal,
            &format!("Herdr Commander: {workspace_name}"),
            &task_items,
            false,
        )?;

        let selected_task = match task_result {
            PickerResult::Selected(t) => t,
            _ => return Ok(()),
        };

        // Placement picker
        let placements = placement_picker_items();
        let placement_result = run_picker(
            &mut guard.terminal,
            &format!("Placement for: {}", selected_task.label),
            &placements,
            true,
        )?;

        let selected_placement = match placement_result {
            PickerResult::Selected(p) => p,
            PickerResult::Back => continue,
            PickerResult::Quit => return Ok(()),
        };

        // Resolve inputs if any
        let mut resolved_inputs = HashMap::new();
        for input in &config.inputs {
            match input.input_type {
                InputType::PromptString => {
                    if let Some(val) = prompt_string(&mut guard.terminal, input)? {
                        resolved_inputs.insert(input.id.clone(), val);
                    } else {
                        // Cancelled input
                        return Ok(());
                    }
                }
                InputType::PickString => {
                    let pick_items: Vec<PickerItem<String>> = input
                        .options
                        .iter()
                        .map(|opt| PickerItem {
                            value: opt.clone(),
                            label: opt.clone(),
                            detail: None,
                            badge: None,
                            searchable: opt.to_lowercase(),
                        })
                        .collect();

                    let desc = input.description.as_deref().unwrap_or(&input.id);
                    match run_picker(&mut guard.terminal, desc, &pick_items, true)? {
                        PickerResult::Selected(val) => {
                            resolved_inputs.insert(input.id.clone(), val);
                        }
                        _ => return Ok(()),
                    }
                }
            }
        }

        // Resolve variables in task
        let mut final_task = selected_task.clone();
        if let Some(ref cmd) = final_task.command {
            final_task.command = Some(config::resolve_variables(cmd, &workspace_dir, &resolved_inputs));
        }
        final_task.args = final_task
            .args
            .iter()
            .map(|arg| config::resolve_variables(arg, &workspace_dir, &resolved_inputs))
            .collect();
        if let Some(ref cwd) = final_task.cwd {
            final_task.cwd = Some(config::resolve_variables(cwd, &workspace_dir, &resolved_inputs));
        }

        // Drop TUI guard before running task to restore normal terminal
        drop(guard);

        println!("Running task: {}...", final_task.label);
        if let Err(err) = execute_task_tree(
            &final_task,
            &config.tasks,
            &workspace_dir,
            selected_placement,
            registry.clone(),
            client.clone(),
        ) {
            eprintln!("Task failed: {err}");
            std::process::exit(1);
        }

        return Ok(());
    }
}

fn ctrlc_handler(registry: Arc<ProcessRegistry>) {
    #[cfg(unix)]
    {
        use std::thread;
        thread::spawn(move || {
            let sigs = [libc::SIGINT, libc::SIGTERM];
            unsafe {
                let mut sigset: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut sigset);
                for &sig in &sigs {
                    libc::sigaddset(&mut sigset, sig);
                }
                libc::pthread_sigmask(libc::SIG_BLOCK, &sigset, std::ptr::null_mut());
                let mut received: libc::c_int = 0;
                while libc::sigwait(&sigset, &mut received) == 0 {
                    registry.cancel_all();
                    std::process::exit(130);
                }
            }
        });
    }
}
