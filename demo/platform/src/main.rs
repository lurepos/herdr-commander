// platform queue worker (demo crate for the cargo: presets)
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Job {
    pub id: u64,
    pub kind: String,
    pub payload: serde_json::Value,
}

fn main() {
    let job = Job {
        id: 1,
        kind: "email.send".into(),
        payload: serde_json::json!({ "to": "demo@platform.dev" }),
    };
    println!("worker drained job {} ({})", job.id, job.kind);
}
