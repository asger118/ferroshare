//! Full stack: relay + host daemon + guest daemon, with fake extensions
//! speaking the JSON control protocol and real CRDT replicas.

use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mls_sync::{DocStore, TextEdit};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::TcpStream;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};

struct Ext {
    lines: Lines<BufReader<OwnedReadHalf>>,
    write: OwnedWriteHalf,
    /// The extension's own replica (Yjs in the real extension).
    docs: DocStore,
}

impl Ext {
    async fn attach(port: u16, token: &str) -> Self {
        let s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (r, write) = s.into_split();
        let mut e = Ext { lines: BufReader::new(r).lines(), write, docs: DocStore::new() };
        e.send(json!({"t": "auth", "token": token})).await;
        e
    }

    async fn send(&mut self, v: Value) {
        self.write.write_all(format!("{v}\n").as_bytes()).await.unwrap();
    }

    /// Next message of type `t`, skipping others.
    async fn expect(&mut self, t: &str) -> Value {
        loop {
            let line = tokio::time::timeout(Duration::from_secs(10), self.lines.next_line())
                .await
                .unwrap_or_else(|_| panic!("timed out waiting for {t}"))
                .unwrap()
                .expect("daemon closed control connection");
            let v: Value = serde_json::from_str(&line).unwrap();
            if v["t"] == t {
                return v;
            }
        }
    }

    async fn edit(&mut self, path: &str, offset: u32, delete: u32, insert: &str) {
        let u = self.docs.apply_local(path, &TextEdit { offset, delete, insert: insert.into() }).unwrap();
        self.send(json!({"t": "update", "path": path, "update": STANDARD.encode(u)})).await;
    }

    fn apply(&mut self, msg: &Value) {
        let path = msg["path"].as_str().unwrap();
        let bytes = STANDARD.decode(msg["update"].as_str().unwrap()).unwrap();
        if msg["t"] == "docState" {
            self.docs.load(path, &bytes).unwrap();
        } else {
            self.docs.apply_remote(path, &bytes).unwrap();
        }
    }
}

async fn start_daemon(mode: mls::Mode, name: &str) -> mls::Ready {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let name = name.to_string();
    tokio::spawn(async move {
        let mut tx = Some(tx);
        mls::run(mode, name, |r| {
            let _ = tx.take().unwrap().send(mls::Ready {
                port: r.port,
                token: r.token.clone(),
                session: r.session.clone(),
                invite: r.invite.clone(),
            });
        })
        .await
        .unwrap();
    });
    rx.await.unwrap()
}

/// In-process relay, or an external one (e.g. the Docker image) via
/// `MLS_TEST_RELAY=ws://127.0.0.1:7777`.
async fn relay() -> String {
    if let Ok(url) = std::env::var("MLS_TEST_RELAY") {
        return url;
    }
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", l.local_addr().unwrap());
    tokio::spawn(mls_relay::Relay::new().serve(l));
    url
}

#[tokio::test]
async fn host_and_guest_collaborate() {
    // Relay.
    let relay_url = relay().await;

    // Workspace.
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("src")).unwrap();
    std::fs::write(dir.path().join("src/Program.cs"), "class P {}\n").unwrap();
    std::fs::write(dir.path().join("logo.png"), [0x89, b'P', 0, 0]).unwrap();

    // Host.
    let host = start_daemon(mls::Mode::Host { relay: relay_url, root: dir.path().into() }, "host").await;
    let mut hx = Ext::attach(host.port, &host.token).await;
    let hello = hx.expect("hello").await;
    assert_eq!(hello["role"], "Host");

    // Guest joins via the invite link.
    let guest = start_daemon(mls::Mode::Join { invite: host.invite.clone() }, "friend").await;
    let mut gx = Ext::attach(guest.port, &guest.token).await;
    let ghello = gx.expect("hello").await;
    assert_eq!(ghello["role"], "Guest");
    assert_eq!(ghello["peers"][0]["name"], "host");
    assert_eq!(hx.expect("peerJoined").await["peer"]["name"], "friend");
    let guest_id = ghello["me"].as_u64().unwrap();

    // Guest browses the workspace.
    gx.send(json!({"t": "fs", "id": 1, "op": {"readDir": ""}})).await;
    let r = gx.expect("fsResult").await;
    let names: Vec<_> = r["ok"]["dir"].as_array().unwrap().iter().map(|e| e["name"].clone()).collect();
    assert_eq!(names, [json!("logo.png"), json!("src")]);

    // Escaping the workspace is refused.
    gx.send(json!({"t": "fs", "id": 2, "op": {"read": "../secret"}})).await;
    assert!(gx.expect("fsResult").await["err"].as_str().unwrap().contains("invalid path"));

    // Binary files can't be live documents but can be read raw.
    gx.send(json!({"t": "open", "path": "logo.png"})).await;
    assert_eq!(gx.expect("openFailed").await["error"], "binary");

    // Guest opens a document: host editor is asked for its buffer, which
    // has unsaved changes the guest must see.
    gx.send(json!({"t": "open", "path": "src/Program.cs"})).await;
    let rd = hx.expect("readDoc").await;
    assert_eq!(rd["path"], "src/Program.cs");
    hx.send(json!({"t": "docText", "path": "src/Program.cs", "text": "class P { /* unsaved */ }\n"})).await;
    let st = hx.expect("docState").await;
    hx.apply(&st);
    let st = gx.expect("docState").await;
    gx.apply(&st);
    assert_eq!(gx.docs.text("src/Program.cs").unwrap(), "class P { /* unsaved */ }\n");

    // Both type at once.
    gx.edit("src/Program.cs", 0, 0, "public ").await;
    hx.edit("src/Program.cs", 26, 0, "// host\n").await; // after the first line
    let u = hx.expect("update").await;
    hx.apply(&u);
    let u = gx.expect("update").await;
    gx.apply(&u);
    let (h, g) = (hx.docs.text("src/Program.cs").unwrap(), gx.docs.text("src/Program.cs").unwrap());
    assert_eq!(h, g);
    assert_eq!(h, "public class P { /* unsaved */ }\n// host\n");

    // Guest saves -> host editor is told to save.
    gx.send(json!({"t": "save", "path": "src/Program.cs"})).await;
    assert_eq!(hx.expect("save").await["path"], "src/Program.cs");

    // IntelliSense round-trip through the host's editor.
    gx.send(json!({"t": "langRequest", "id": 7, "method": "hover", "args": "{}"})).await;
    let req = hx.expect("langRequest").await;
    assert_eq!(req["from"].as_u64().unwrap(), guest_id);
    hx.send(json!({"t": "langResponse", "to": guest_id, "id": 7, "ok": "[\"docs\"]", "err": null})).await;
    let resp = gx.expect("langResponse").await;
    assert_eq!((resp["id"].as_u64(), resp["ok"].as_str()), (Some(7), Some("[\"docs\"]")));

    // Presence goes to the other side.
    gx.send(json!({"t": "presence", "path": "src/Program.cs", "data": "{\"c\":1}"})).await;
    assert_eq!(hx.expect("presence").await["data"], "{\"c\":1}");

    // A second guest opening the same doc gets the merged state, not disk.
    let g2 = start_daemon(mls::Mode::Join { invite: host.invite.clone() }, "late").await;
    let mut g2x = Ext::attach(g2.port, &g2.token).await;
    g2x.expect("hello").await;
    g2x.send(json!({"t": "open", "path": "src/Program.cs"})).await;
    let st = g2x.expect("docState").await;
    g2x.apply(&st);
    assert_eq!(g2x.docs.text("src/Program.cs").unwrap(), h);

    // Host leaves -> guests are told the session ended.
    hx.send(json!({"t": "leave"})).await;
    assert_eq!(gx.expect("ended").await["reason"], "the host ended the session");
}

#[tokio::test]
async fn bad_invite_reports_error() {
    let key = mls::crypto::SessionKey::generate().encode();
    let r = mls::run(mls::Mode::Join { invite: format!("ws://127.0.0.1:1#a.b.{key}") }, "x".into(), |_| {}).await;
    assert!(r.unwrap_err().to_string().contains("could not reach relay"));
}

/// Someone who controls the relay knows the session id and token, but not the
/// key, which only travels in the invite's `#fragment`. They can join, but they
/// must not be able to read anything or inject anything.
#[tokio::test]
async fn relay_cannot_read_or_inject() {
    use futures_util::{SinkExt, StreamExt};
    use mls_proto::{AppMsg, PROTOCOL_VERSION, RelayMsg};
    use tokio_tungstenite::tungstenite::Message;

    let relay_url = relay().await;

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("secret.cs"), "class TopSecret {}\n").unwrap();

    let host = start_daemon(mls::Mode::Host { relay: relay_url.clone(), root: dir.path().into() }, "host").await;
    let mut hx = Ext::attach(host.port, &host.token).await;
    let host_id = hx.expect("hello").await["me"].as_u64().unwrap() as u32;

    // The eavesdropper joins with everything except the key.
    let (rest, _key) = host.invite.rsplit_once('.').unwrap();
    let (_, session_token) = rest.split_once('#').unwrap();
    let (session, token) = session_token.split_once('.').unwrap();
    let (mut spy, _) = tokio_tungstenite::connect_async(&relay_url).await.unwrap();
    let join = RelayMsg::JoinSession { version: PROTOCOL_VERSION, session: session.into(), token: token.into(), name: "spy".into() };
    spy.send(Message::Binary(mls_proto::encode(&join).unwrap().into())).await.unwrap();

    // A real guest opens the file and types; presence is broadcast to everyone, spy included.
    let guest = start_daemon(mls::Mode::Join { invite: host.invite.clone() }, "friend").await;
    let mut gx = Ext::attach(guest.port, &guest.token).await;
    gx.expect("hello").await;
    gx.send(json!({"t": "open", "path": "secret.cs"})).await;
    let rd = hx.expect("readDoc").await;
    hx.send(json!({"t": "docText", "path": rd["path"], "text": null})).await;
    let st = gx.expect("docState").await;
    gx.apply(&st);
    gx.edit("secret.cs", 0, 0, "// PASSWORD=hunter2\n").await;
    gx.send(json!({"t": "presence", "path": "secret.cs", "data": "{\"cursor\":\"TopSecret\"}"})).await;
    hx.expect("presence").await;

    // The spy tries to inject: a plaintext save, and a forged sealed one.
    for payload in [
        mls_proto::encode(&AppMsg::Save { path: "secret.cs".into() }).unwrap(),
        mls::crypto::Sealer::new(&mls::crypto::SessionKey::generate(), session, 999)
            .seal(&mls_proto::encode(&AppMsg::Save { path: "secret.cs".into() }).unwrap()),
    ] {
        let m = RelayMsg::Send { to: Some(host_id), payload };
        spy.send(Message::Binary(mls_proto::encode(&m).unwrap().into())).await.unwrap();
    }
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Only the real guest's save reaches the host editor.
    std::fs::write(dir.path().join("other.cs"), "x\n").unwrap();
    gx.send(json!({"t": "save", "path": "other.cs"})).await;
    assert_eq!(hx.expect("save").await["path"], "other.cs", "injected save must be dropped");

    // Everything the spy received is ciphertext.
    let mut envelopes = 0;
    while let Ok(Some(Ok(Message::Binary(b)))) = tokio::time::timeout(Duration::from_millis(500), spy.next()).await {
        if let RelayMsg::Envelope { payload, .. } = mls_proto::decode::<RelayMsg>(&b).unwrap() {
            envelopes += 1;
            assert!(mls_proto::decode::<AppMsg>(&payload).is_err(), "spy decoded a plaintext AppMsg");
            for needle in [&b"TopSecret"[..], b"hunter2", b"secret.cs", b"cursor"] {
                assert!(!payload.windows(needle.len()).any(|w| w == needle), "spy saw {:?}", String::from_utf8_lossy(needle));
            }
        }
    }
    assert!(envelopes > 0, "spy should have received (encrypted) broadcasts");
}

impl Ext {
    /// Collect `termOutput` for terminal `id` until it contains `needle`.
    async fn expect_output(&mut self, id: u64, needle: &str) -> String {
        let mut seen = String::new();
        loop {
            let m = match tokio::time::timeout(Duration::from_secs(8), self.expect("termOutput")).await {
                Ok(m) => m,
                Err(_) => panic!("no {needle:?} in terminal {id} output: {seen:?}"),
            };
            if m["id"].as_u64() == Some(id) {
                seen.push_str(&String::from_utf8_lossy(&STANDARD.decode(m["data"].as_str().unwrap()).unwrap()));
                if seen.contains(needle) {
                    return seen;
                }
            }
        }
    }
}

/// Like the host's real terminal widget: answer the cursor-position query
/// Windows' ConPTY sends before it starts the shell.
async fn answer_cursor_query(hx: &mut Ext, id: u64) {
    if cfg!(windows) {
        hx.expect_output(id, "\u{1b}[6n").await;
        hx.send(json!({"t": "termInput", "id": id, "data": "\u{1b}[1;1R"})).await;
    }
}

/// Shell for the terminal tests, and a line that makes it print `40+n`
/// without that number appearing in the echoed command itself.
fn shell_and_sum(n: u32) -> (&'static str, String) {
    if cfg!(windows) { ("cmd.exe", format!("set /a 40+{n}\r\n")) } else { ("/bin/sh", format!("echo $((40+{n}))\n")) }
}

#[tokio::test]
async fn guest_changes_files_through_the_host_editor() {
    let relay_url = relay().await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("src")).unwrap();
    std::fs::write(dir.path().join("src/a.txt"), "hello\n").unwrap();

    let host = start_daemon(mls::Mode::Host { relay: relay_url, root: dir.path().into() }, "host").await;
    let mut hx = Ext::attach(host.port, &host.token).await;
    hx.expect("hello").await;
    let guest = start_daemon(mls::Mode::Join { invite: host.invite.clone() }, "friend").await;
    let mut gx = Ext::attach(guest.port, &guest.token).await;
    gx.expect("hello").await;

    // The guest has src/a.txt open as a shared document.
    gx.send(json!({"t": "open", "path": "src/a.txt"})).await;
    hx.expect("readDoc").await;
    hx.send(json!({"t": "docText", "path": "src/a.txt", "text": null})).await;
    let st = hx.expect("docState").await;
    hx.apply(&st);
    let st = gx.expect("docState").await;
    gx.apply(&st);

    // Create a file: the host editor is asked to do it, then everyone hears about it.
    gx.send(json!({"t": "fs", "id": 1, "op": {"write": {"path": "new.txt", "data": "aGk=", "create": true, "overwrite": false}}})).await;
    let apply = hx.expect("fsApply").await;
    assert_eq!(apply["op"]["write"]["path"], "new.txt");
    assert_eq!(apply["op"]["write"]["data"], "aGk=");
    std::fs::write(dir.path().join("new.txt"), "hi").unwrap();
    hx.send(json!({"t": "fsApplied", "id": apply["id"], "err": null})).await;
    let r = gx.expect("fsResult").await;
    assert_eq!((r["id"].as_u64(), r["ok"].as_str()), (Some(1), Some("done")));
    assert_eq!(gx.expect("fsChanged").await["created"], json!(["new.txt"]));
    assert_eq!(hx.expect("fsChanged").await["created"], json!(["new.txt"]));

    // The sandbox refuses before the host editor is ever asked.
    gx.send(json!({"t": "fs", "id": 2, "op": {"write": {"path": ".git/hooks/pre-commit", "data": "", "create": true, "overwrite": true}}})).await;
    assert!(gx.expect("fsResult").await["err"].as_str().unwrap().starts_with("NoPermissions:"));
    gx.send(json!({"t": "fs", "id": 3, "op": {"delete": {"path": "../outside", "recursive": true}}})).await;
    assert!(gx.expect("fsResult").await["err"].as_str().unwrap().starts_with("NoPermissions:"));

    // The host editor can refuse too, and the guest gets the reason.
    gx.send(json!({"t": "fs", "id": 4, "op": {"createDir": "made"}})).await;
    let apply = hx.expect("fsApply").await;
    assert_eq!(apply["op"]["createDir"], "made", "refused ops must not reach the host editor");
    hx.send(json!({"t": "fsApplied", "id": apply["id"], "err": "NoPermissions: read-only disk"})).await;
    assert_eq!(gx.expect("fsResult").await["err"], "NoPermissions: read-only disk");

    // Rename the open document (by moving its folder): it lives on under the
    // new name for everyone, with its content, and editing carries on.
    gx.send(json!({"t": "fs", "id": 5, "op": {"rename": {"from": "src", "to": "lib", "overwrite": false}}})).await;
    let apply = hx.expect("fsApply").await;
    std::fs::rename(dir.path().join("src"), dir.path().join("lib")).unwrap();
    hx.send(json!({"t": "fsApplied", "id": apply["id"], "err": null})).await;
    gx.expect("fsResult").await;
    for x in [&mut gx, &mut hx] {
        let ch = x.expect("fsChanged").await;
        assert_eq!(ch["renamed"], json!([["src", "lib"]]));
        assert_eq!((ch["removed"].clone(), ch["created"].clone()), (json!([]), json!([])), "a rename is not a delete");
        let st = x.expect("docState").await;
        assert_eq!(st["path"], "lib/a.txt");
        x.apply(&st);
        assert_eq!(x.docs.text("lib/a.txt").unwrap(), "hello\n");
    }
    gx.edit("lib/a.txt", 0, 0, "oh ").await;
    let u = hx.expect("update").await;
    assert_eq!(u["path"], "lib/a.txt");
    hx.apply(&u);
    assert_eq!(hx.docs.text("lib/a.txt").unwrap(), "oh hello\n");
    gx.send(json!({"t": "open", "path": "src/a.txt"})).await;
    assert_eq!(gx.expect("openFailed").await["path"], "src/a.txt");

    // A rename on the host itself works the same way.
    std::fs::rename(dir.path().join("lib/a.txt"), dir.path().join("lib/c.txt")).unwrap();
    hx.send(json!({"t": "fsNotify", "renamed": [["lib/a.txt", "lib/c.txt"]]})).await;
    assert_eq!(gx.expect("fsChanged").await["renamed"], json!([["lib/a.txt", "lib/c.txt"]]));
    assert_eq!(gx.expect("docState").await["path"], "lib/c.txt");

    // Changes the host makes itself reach guests as well.
    hx.send(json!({"t": "fsNotify", "removed": ["new.txt"]})).await;
    assert_eq!(gx.expect("fsChanged").await["removed"], json!(["new.txt"]));
}

#[tokio::test]
async fn host_shares_terminals() {
    let relay_url = relay().await;
    let dir = tempfile::tempdir().unwrap();
    let host = start_daemon(mls::Mode::Host { relay: relay_url, root: dir.path().into() }, "host").await;
    let mut hx = Ext::attach(host.port, &host.token).await;
    let hme = hx.expect("hello").await["me"].as_u64().unwrap();
    let guest = start_daemon(mls::Mode::Join { invite: host.invite.clone() }, "friend").await;
    let mut gx = Ext::attach(guest.port, &guest.token).await;
    let gme = gx.expect("hello").await["me"].as_u64().unwrap();
    hx.expect("peerJoined").await;

    // A read-only terminal: everyone sees the output, only the host types.
    let (shell, line) = shell_and_sum(2);
    hx.send(json!({"t": "termOpen", "name": "build", "shell": shell, "writable": false})).await;
    let opened = hx.expect("termOpened").await;
    let ro = opened["id"].as_u64().unwrap();
    answer_cursor_query(&mut hx, ro).await;
    let g = gx.expect("termOpened").await;
    assert_eq!((g["id"].as_u64(), g["name"].as_str(), g["writable"].as_bool()), (Some(ro), Some("build"), Some(false)));
    hx.send(json!({"t": "termInput", "id": ro, "data": line})).await;
    gx.expect_output(ro, "42").await;

    // The guest's keystrokes don't reach a read-only terminal.
    let (_, sneaky) = shell_and_sum(9);
    gx.send(json!({"t": "termInput", "id": ro, "data": sneaky})).await;

    // A writable one: the guest can run commands on the host.
    hx.send(json!({"t": "termOpen", "name": "shell", "shell": shell, "writable": true})).await;
    let rw = hx.expect("termOpened").await["id"].as_u64().unwrap();
    answer_cursor_query(&mut hx, rw).await;
    assert_eq!(gx.expect("termOpened").await["writable"], true);
    let (_, line) = shell_and_sum(16);
    gx.send(json!({"t": "termInput", "id": rw, "data": line})).await;
    gx.expect_output(rw, "56").await;

    // The shell fits the tab of whoever typed last: the host, here...
    hx.send(json!({"t": "termInput", "id": rw, "data": "\r"})).await;
    let size = |s: serde_json::Value| (s["cols"].as_u64().unwrap(), s["rows"].as_u64().unwrap(), s["by"].as_u64().unwrap());
    hx.send(json!({"t": "termResize", "id": rw, "cols": 120, "rows": 40})).await;
    let s = gx.expect("termSize").await;
    assert_eq!(s["id"].as_u64(), Some(rw));
    assert_eq!(size(s), (120, 40, hme));
    assert_eq!(size(hx.expect("termSize").await), (120, 40, hme));
    // ...a guest's tab doesn't change it until they ask for it (or type)...
    gx.send(json!({"t": "termResize", "id": rw, "cols": 70, "rows": 50})).await;
    gx.send(json!({"t": "termFit", "id": rw})).await;
    assert_eq!(size(hx.expect("termSize").await), (70, 50, gme));
    assert_eq!(size(gx.expect("termSize").await), (70, 50, gme));
    let probe = if cfg!(windows) { "mode con\r\n" } else { "stty size\n" };
    gx.send(json!({"t": "termInput", "id": rw, "data": probe})).await;
    gx.expect_output(rw, if cfg!(windows) { "70" } else { "50 70" }).await;
    // ...the host's terminal answering the shell isn't the host typing...
    hx.send(json!({"t": "termInput", "id": rw, "data": "\u{1b}[5;5R"})).await;
    gx.send(json!({"t": "termResize", "id": rw, "cols": 60, "rows": 50})).await;
    assert_eq!(size(hx.expect("termSize").await), (60, 50, gme));
    // ...it goes back to the host's size when the guest closes their tab...
    gx.send(json!({"t": "termResize", "id": rw, "cols": 0, "rows": 0})).await;
    assert_eq!(size(hx.expect("termSize").await), (120, 40, hme));
    // ...is never made unusably small...
    gx.send(json!({"t": "termResize", "id": rw, "cols": 1, "rows": 1})).await;
    gx.send(json!({"t": "termFit", "id": rw})).await;
    assert_eq!(size(hx.expect("termSize").await), (20, 5, gme));
    // ...and follows the host again once they type.
    hx.send(json!({"t": "termInput", "id": rw, "data": "\r"})).await;
    assert_eq!(size(hx.expect("termSize").await), (120, 40, hme));

    // Someone joining later gets the open terminals with their history.
    let late = start_daemon(mls::Mode::Join { invite: host.invite.clone() }, "late").await;
    let mut lx = Ext::attach(late.port, &late.token).await;
    lx.expect("hello").await;
    assert_eq!(lx.expect("termOpened").await["id"].as_u64(), Some(ro));
    let history = lx.expect_output(ro, "42").await;
    assert!(!history.contains("49"), "read-only terminal ran the guest's command: {history:?}");

    // The host closes it: it's gone for everyone.
    hx.send(json!({"t": "termClose", "id": ro})).await;
    assert_eq!(gx.expect("termClosed").await["id"].as_u64(), Some(ro));
    hx.send(json!({"t": "leave"})).await;
}
