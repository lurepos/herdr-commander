use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskSource {
    VsCode,
    Npm,
    Cargo,
    Make,
}

impl std::fmt::Display for TaskSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::VsCode => write!(f, "vscode"),
            Self::Npm => write!(f, "npm"),
            Self::Cargo => write!(f, "cargo"),
            Self::Make => write!(f, "make"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DependsOrder {
    Sequence,
    Parallel,
}

impl Default for DependsOrder {
    fn default() -> Self {
        Self::Sequence
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub label: String,
    #[serde(default)]
    pub task_type: Option<String>,
    pub source: TaskSource,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub script: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub depends_order: DependsOrder,
    #[serde(default)]
    pub detail: Option<String>,
}

impl Task {
    pub fn display_command(&self) -> String {
        if let Some(ref script) = self.script {
            format!("npm run {script}")
        } else if let Some(ref cmd) = self.command {
            if self.args.is_empty() {
                cmd.clone()
            } else {
                format!("{cmd} {}", self.args.join(" "))
            }
        } else if !self.depends_on.is_empty() {
            format!("composite: {}", self.depends_on.join(", "))
        } else {
            "no command".to_string()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputType {
    PromptString,
    PickString,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskInput {
    pub id: String,
    #[serde(rename = "type", default = "default_input_type")]
    pub input_type: InputType,
    pub description: Option<String>,
    pub default: Option<String>,
    #[serde(default)]
    pub options: Vec<String>,
}

fn default_input_type() -> InputType {
    InputType::PromptString
}

#[derive(Debug, Clone, Default)]
pub struct TaskConfig {
    pub workspace_cwd: PathBuf,
    #[allow(dead_code)]
    pub tasks_path: Option<PathBuf>,
    pub tasks: Vec<Task>,
    pub inputs: Vec<TaskInput>,
}

pub fn strip_jsonc_comments(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut escape = false;

    while let Some(c) = chars.next() {
        if in_string {
            output.push(c);
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }

        if c == '"' {
            in_string = true;
            output.push(c);
            continue;
        }

        if c == '/' {
            match chars.peek() {
                Some('/') => {
                    // Line comment: skip until newline
                    chars.next();
                    for next_c in chars.by_ref() {
                        if next_c == '\n' {
                            output.push('\n');
                            break;
                        }
                    }
                    continue;
                }
                Some('*') => {
                    // Block comment: skip until */
                    chars.next();
                    let mut prev = ' ';
                    for next_c in chars.by_ref() {
                        if prev == '*' && next_c == '/' {
                            break;
                        }
                        if next_c == '\n' {
                            output.push('\n');
                        }
                        prev = next_c;
                    }
                    continue;
                }
                _ => {}
            }
        }

        output.push(c);
    }

    // Remove trailing commas before } or ]
    let mut sanitized = String::with_capacity(output.len());
    let chars_vec: Vec<char> = output.chars().collect();
    let len = chars_vec.len();
    let mut i = 0;
    while i < len {
        let ch = chars_vec[i];
        if ch == ',' {
            let mut j = i + 1;
            while j < len && chars_vec[j].is_whitespace() {
                j += 1;
            }
            if j < len && (chars_vec[j] == '}' || chars_vec[j] == ']') {
                i += 1;
                continue;
            }
        }
        sanitized.push(ch);
        i += 1;
    }

    sanitized
}

#[derive(Deserialize)]
struct RawTasksJson {
    #[serde(default)]
    tasks: Vec<RawTask>,
    #[serde(default)]
    inputs: Vec<RawInput>,
}

#[derive(Deserialize)]
struct RawTask {
    label: String,
    #[serde(rename = "type", default)]
    task_type: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    script: Option<String>,
    #[serde(default)]
    options: Option<RawTaskOptions>,
    #[serde(default)]
    #[serde(rename = "dependsOn")]
    depends_on: Option<RawDependsOn>,
    #[serde(default)]
    #[serde(rename = "dependsOrder")]
    depends_order: Option<DependsOrder>,
    #[serde(default)]
    detail: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawDependsOn {
    Single(String),
    Multiple(Vec<String>),
}

#[derive(Deserialize, Default)]
struct RawTaskOptions {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
struct RawInput {
    id: String,
    #[serde(rename = "type", default)]
    input_type: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    default: Option<String>,
    #[serde(default)]
    options: Option<Vec<String>>,
}

pub fn find_tasks_file(start: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut current = start.to_path_buf();
    loop {
        let candidate = current.join(".vscode").join("tasks.json");
        if candidate.is_file() {
            return Some((current, candidate));
        }
        if !current.pop() {
            break;
        }
    }
    None
}

pub fn parse_tasks_json(path: &Path, workspace_cwd: &Path) -> Result<TaskConfig, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let sanitized = strip_jsonc_comments(&content);
    let raw: RawTasksJson = serde_json::from_str(&sanitized)
        .map_err(|e| format!("{}: invalid JSONC ({e})", path.display()))?;

    let tasks = raw
        .tasks
        .into_iter()
        .map(|r| {
            let depends_on = match r.depends_on {
                Some(RawDependsOn::Single(s)) => vec![s],
                Some(RawDependsOn::Multiple(m)) => m,
                None => Vec::new(),
            };
            let (cwd, env) = if let Some(opt) = r.options {
                (opt.cwd, opt.env.unwrap_or_default())
            } else {
                (None, HashMap::new())
            };
            Task {
                label: r.label,
                task_type: r.task_type,
                source: TaskSource::VsCode,
                command: r.command,
                args: r.args.unwrap_or_default(),
                script: r.script,
                cwd,
                env,
                depends_on,
                depends_order: r.depends_order.unwrap_or_default(),
                detail: r.detail,
            }
        })
        .collect();

    let inputs = raw
        .inputs
        .into_iter()
        .map(|i| {
            let input_type = match i.input_type.as_deref() {
                Some("pickString") => InputType::PickString,
                _ => InputType::PromptString,
            };
            TaskInput {
                id: i.id,
                input_type,
                description: i.description,
                default: i.default,
                options: i.options.unwrap_or_default(),
            }
        })
        .collect();

    Ok(TaskConfig {
        workspace_cwd: workspace_cwd.to_path_buf(),
        tasks_path: Some(path.to_path_buf()),
        tasks,
        inputs,
    })
}

pub fn resolve_variables(
    value: &str,
    workspace_folder: &Path,
    inputs: &HashMap<String, String>,
) -> String {
    let mut result = value.to_string();
    let ws_str = workspace_folder.to_string_lossy();
    result = result.replace("${workspaceFolder}", &ws_str);

    for (id, val) in inputs {
        result = result.replace(&format!("${{input:{id}}}"), val);
    }

    // Replace ${env:NAME}
    while let Some(start) = result.find("${env:") {
        if let Some(end) = result[start..].find('}') {
            let var_name = &result[start + 6..start + end];
            let env_val = std::env::var(var_name).unwrap_or_default();
            result.replace_range(start..start + end + 1, &env_val);
        } else {
            break;
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_jsonc_comments() {
        let jsonc = r#"{
            // Line comment
            "tasks": [
                {
                    "label": "test", /* inline block */
                    "command": "echo https://example.com", // trailing
                },
            ],
        }"#;
        let stripped = strip_jsonc_comments(jsonc);
        let parsed: serde_json::Value = serde_json::from_str(&stripped).expect("Should parse");
        assert_eq!(parsed["tasks"][0]["label"], "test");
        assert_eq!(parsed["tasks"][0]["command"], "echo https://example.com");
    }

    #[test]
    fn test_resolve_variables() {
        std::env::set_var("HERDR_TEST_VAR", "foo");
        let mut inputs = HashMap::new();
        inputs.insert("target".to_string(), "prod".to_string());
        let ws = Path::new("/my/project");

        let resolved = resolve_variables(
            "${workspaceFolder}/build/${env:HERDR_TEST_VAR}/${input:target}",
            ws,
            &inputs,
        );
        assert_eq!(resolved, "/my/project/build/foo/prod");
    }
}
