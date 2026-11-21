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
