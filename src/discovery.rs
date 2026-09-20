use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use serde::Deserialize;

use crate::config::{find_tasks_file, parse_tasks_json, Task, TaskConfig, TaskSource};

#[derive(Deserialize)]
struct PackageJson {
    #[serde(default)]
    scripts: HashMap<String, String>,
}

pub fn discover_all_tasks(start_dir: &Path) -> (PathBuf, TaskConfig) {
    let mut config = if let Some((ws, tasks_path)) = find_tasks_file(start_dir) {
        match parse_tasks_json(&tasks_path, &ws) {
            Ok(cfg) => cfg,
            Err(_) => TaskConfig {
                workspace_cwd: ws,
                tasks_path: Some(tasks_path),
                ..Default::default()
            },
        }
    } else {
        TaskConfig {
            workspace_cwd: start_dir.to_path_buf(),
            tasks_path: None,
            ..Default::default()
        }
    };

    let ws = config.workspace_cwd.clone();
    let mut discovered = Vec::new();
    let existing_labels: HashSet<String> = config.tasks.iter().map(|t| t.label.clone()).collect();

    // 1. package.json scripts
    let pkg_json_path = ws.join("package.json");
    if pkg_json_path.is_file() {
        if let Ok(content) = fs::read_to_string(&pkg_json_path) {
            if let Ok(pkg) = serde_json::from_str::<PackageJson>(&content) {
                let mut scripts: Vec<(String, String)> = pkg.scripts.into_iter().collect();
                scripts.sort_by(|a, b| a.0.cmp(&b.0));
                for (script_name, script_cmd) in scripts {
                    let label = format!("npm: {script_name}");
                    if !existing_labels.contains(&label) {
                        discovered.push(Task {
                            label,
                            task_type: Some("npm".to_string()),
                            source: TaskSource::Npm,
                            command: Some("npm".to_string()),
                            args: vec!["run".to_string(), script_name.clone()],
                            script: Some(script_name),
                            cwd: None,
                            env: HashMap::new(),
                            depends_on: Vec::new(),
                            depends_order: Default::default(),
                            detail: Some(script_cmd),
                        });
                    }
                }
            }
        }
    }

    // 2. Cargo.toml targets
    let cargo_toml_path = ws.join("Cargo.toml");
    if cargo_toml_path.is_file() {
        let default_cargo_tasks = vec![
            ("cargo: check", "cargo", vec!["check"]),
            ("cargo: test", "cargo", vec!["test"]),
            ("cargo: build", "cargo", vec!["build"]),
            ("cargo: build --release", "cargo", vec!["build", "--release"]),
            ("cargo: clippy", "cargo", vec!["clippy"]),
        ];
        for (label, cmd, args) in default_cargo_tasks {
            if !existing_labels.contains(label) {
                discovered.push(Task {
                    label: label.to_string(),
                    task_type: Some("cargo".to_string()),
                    source: TaskSource::Cargo,
                    command: Some(cmd.to_string()),
                    args: args.into_iter().map(String::from).collect(),
                    script: None,
                    cwd: None,
                    env: HashMap::new(),
                    depends_on: Vec::new(),
                    depends_order: Default::default(),
                    detail: None,
                });
            }
        }
    }

    // 3. Makefile targets
    let makefile_path = ws.join("Makefile");
    if makefile_path.is_file() {
        if let Ok(content) = fs::read_to_string(&makefile_path) {
            for line in content.lines() {
                // Look for targets like `build:` or `test: dep`
                if let Some((target, _)) = line.split_once(':') {
                    let trimmed = target.trim();
                    if !trimmed.is_empty()
                        && !trimmed.starts_with('.')
                        && !trimmed.starts_with('#')
                        && !trimmed.contains('=')
                        && !trimmed.contains('%')
                    {
                        let label = format!("make: {trimmed}");
                        if !existing_labels.contains(&label) {
                            discovered.push(Task {
                                label,
                                task_type: Some("make".to_string()),
                                source: TaskSource::Make,
                                command: Some("make".to_string()),
                                args: vec![trimmed.to_string()],
                                script: None,
                                cwd: None,
                                env: HashMap::new(),
                                depends_on: Vec::new(),
                                depends_order: Default::default(),
                                detail: None,
                            });
                        }
                    }
                }
            }
        }
    }

    config.tasks.extend(discovered);
    (ws, config)
}

pub fn create_default_tasks_json(workspace_cwd: &Path) -> Result<PathBuf, String> {
    let vscode_dir = workspace_cwd.join(".vscode");
    fs::create_dir_all(&vscode_dir).map_err(|e| format!("Failed to create .vscode dir: {e}"))?;
    let tasks_file = vscode_dir.join("tasks.json");
    if tasks_file.exists() {
        return Ok(tasks_file);
    }

    let default_content = r#"{
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
"#;
    fs::write(&tasks_file, default_content)
        .map_err(|e| format!("Failed to write {}: {e}", tasks_file.display()))?;
    Ok(tasks_file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_retro_search_finds_root_workspace() {
        let temp_base = std::env::temp_dir().join(format!("herdr_test_{}", std::process::id()));
        let root = temp_base.join("workspace_root");
        let subfolder = root.join("apps").join("backend-laravel");
        fs::create_dir_all(&subfolder).unwrap();

        let vscode_dir = root.join(".vscode");
        fs::create_dir_all(&vscode_dir).unwrap();
        let tasks_file = vscode_dir.join("tasks.json");
        fs::write(&tasks_file, r#"{"version":"2.0.0","tasks":[]}"#).unwrap();

        let (found_ws, found_file) = find_tasks_file(&subfolder).expect("Must find tasks file");
        assert_eq!(found_ws, root);
        assert_eq!(found_file, tasks_file);

        let (ws, config) = discover_all_tasks(&subfolder);
        assert_eq!(ws, root);
        assert_eq!(config.workspace_cwd, root);

        let _ = fs::remove_dir_all(&temp_base);
    }
}
