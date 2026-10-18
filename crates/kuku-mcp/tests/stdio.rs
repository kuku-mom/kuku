#![cfg(unix)]
use kuku_memory::{Actor, Remember, Store, brief};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixListener,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

struct Client {
    child: std::process::Child,
    output: BufReader<std::process::ChildStdout>,
}
impl Client {
    fn start(socket: &str, id: &str) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_kuku-mcp"))
            .args(["--socket", socket, "--connection", id])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut client = Self { child, output };
        let result=client.rpc(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":id,"version":"1"}}}));
        assert!(result.get("result").is_some(), "{result}");
        writeln!(
            client.child.stdin.as_mut().unwrap(),
            "{}",
            json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .unwrap();
        client
    }
    fn rpc(&mut self, value: Value) -> Value {
        writeln!(self.child.stdin.as_mut().unwrap(), "{value}").unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn call(&mut self, name: &str, args: Value) -> Value {
        let reply=self.rpc(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":name,"arguments":args}}));
        if reply["result"]["isError"] == true {
            return reply["result"].clone();
        }
        serde_json::from_str(
            reply["result"]["content"][0]["text"]
                .as_str()
                .expect("MCP text result"),
        )
        .unwrap()
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn two_stdio_clients_share_versioned_memory_without_a_runtime() {
    let directory = tempfile::tempdir().unwrap();
    let socket = directory.path().join("bridge.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    let root = directory.path().to_path_buf();
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let server = std::thread::spawn(move || {
        while !stopped.load(Ordering::SeqCst) {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            let actor = Actor {
                client: request["connection"].as_str().unwrap().into(),
                scopes: vec!["project".into()],
                auto_scopes: vec!["project".into()],
            };
            let mut store = Store::open(&root).unwrap();
            let params = &request["params"];
            let result = match request["method"].as_str().unwrap() {
                "memory_checkpoint" => serde_json::to_value(
                    store
                        .remember(
                            &actor,
                            serde_json::from_value::<kuku_memory::checkpoint::Checkpoint>(
                                params.clone(),
                            )
                            .unwrap()
                            .into_remember()
                            .unwrap(),
                        )
                        .unwrap(),
                )
                .unwrap(),
                "memory_remember" => serde_json::to_value(
                    store
                        .remember(
                            &actor,
                            serde_json::from_value::<Remember>(params.clone()).unwrap(),
                        )
                        .unwrap(),
                )
                .unwrap(),
                "memory_context" | "memory_search" => match store.search_filtered(
                    &actor,
                    params["query"].as_str().unwrap_or(""),
                    params["scope"].as_str(),
                    5,
                    params["task_id"].as_str(),
                    params["kind"].as_str(),
                ) {
                    Ok(records) => {
                        json!({"context":kuku_memory::checkpoint::context(&records,6000),"memories":brief(records)})
                    }
                    Err(e) => {
                        writeln!(stream, "{}", json!({"error":e})).unwrap();
                        continue;
                    }
                },
                "memory_read" => serde_json::to_value(
                    store
                        .read_active(&actor, params["id"].as_str().unwrap())
                        .unwrap(),
                )
                .unwrap(),
                _ => panic!("unexpected tool"),
            };
            writeln!(stream, "{}", json!({"result":result})).unwrap();
        }
    });
    let mut claude = Client::start(socket.to_str().unwrap(), "claude");
    let tools = claude.rpc(json!({"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}));
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 5);
    let checkpoint=claude.call("memory_checkpoint",json!({"request_id":"handoff-1","scope":"project","title":"Release progress","record":{"task_id":"release","goal":"Shared memory","state":"Read verified; deployment pending","occurred_at":"2026-10-18T00:00:00Z","experiences":[{"conditions":"OAuth registration","method":"Accept extension metadata","result":"Connection succeeded","outcome":"success"}]}}));
    assert_eq!(checkpoint["status"], "committed");
    let mut codex = Client::start(socket.to_str().unwrap(), "codex");
    let resumed = codex.call(
        "memory_context",
        json!({"scope":"project","task_id":"release"}),
    );
    assert_eq!(
        resumed["context"]["checkpoints"][0]["record"]["state"],
        "Read verified; deployment pending"
    );
    let saved=claude.call("memory_remember",json!({"request_id":"decision-1","scope":"project","title":"Package manager","body":"이 프로젝트는 pnpm을 사용한다.","kind":"preference","tags":["retained-tag"],"source_refs":[{"path":"Notes/evidence.md","quote":"Synthetic evidence","captured_at":"2026-10-18T00:00:00Z"}]}));
    assert_eq!(saved["status"], "committed");
    let recalled = codex.call("memory_context", json!({"query":"pnpm","scope":"project"}));
    assert_eq!(recalled["memories"][0]["id"], saved["id"]);
    let record = codex.call("memory_read", json!({"id":saved["id"]}));
    assert!(record["body"].as_str().unwrap().contains("pnpm"));
    let corrected = codex.call("memory_remember", json!({"request_id":"decision-2","scope":"project","title":"Package manager","body":"Use pnpm and English comments.","id":saved["id"],"expected_version":1}));
    assert_eq!(corrected["version"], 2);
    let corrected = claude.call("memory_read", json!({"id":saved["id"]}));
    assert_eq!(corrected["tags"][0], "retained-tag");
    assert_eq!(corrected["kind"], "preference");
    assert_eq!(corrected["source_refs"][0]["quote"], "Synthetic evidence");
    assert_eq!(
        codex.call("memory_search", json!({"query":"pnpm","scope":"private"}))["isError"],
        true
    );
    drop(claude);
    drop(codex);
    stop.store(true, Ordering::SeqCst);
    server.join().unwrap();
}
