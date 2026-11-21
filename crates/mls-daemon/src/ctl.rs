//! Control channel between the VS Code extension and the daemon: JSON lines
//! over an authenticated localhost TCP socket. The daemon outlives VS Code
//! window reloads; the extension simply reconnects.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mls_proto::{DirEntry, FsOp, PeerId, PeerInfo, Role};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::Event;

/// Binary data, base64 in JSON.
#[derive(Debug, Clone, PartialEq)]
pub struct B64(pub Vec<u8>);

impl Serialize for B64 {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(&self.0))
    }
}

impl<'de> Deserialize<'de> for B64 {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        STANDARD.decode(s).map(B64).map_err(serde::de::Error::custom)
    }
}

/// Extension -> daemon.
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CtlIn {
    Auth { token: String },
    /// Start sharing/receiving a text document.
    Open { path: String },
    Close { path: String },
    /// CRDT update produced by the local editor.
    Update { path: String, update: B64 },
    /// Host: reply to `ReadDoc` with the editor's current buffer
    /// (`None` = use the file on disk).
    DocText { path: String, text: Option<String> },
    Fs { id: u64, op: FsOp },
    Presence { path: String, data: String },
    Save { path: String },
    LangRequest { id: u64, method: String, args: String },
    LangResponse {
        to: PeerId,
        id: u64,
        ok: Option<String>,
        err: Option<String>,
    },
    Diagnostics { path: String, json: String },
    /// Host: result of an `FsApply` (`err: None` = done).
    FsApplied { id: u64, err: Option<String> },
    /// Host: the host itself created, changed or removed files.
    FsNotify {
        #[serde(default)]
        created: Vec<String>,
        #[serde(default)]
        changed: Vec<String>,
        #[serde(default)]
        removed: Vec<String>,
    },
    /// Host: start a shared terminal (`shell: None` = platform default).
    TermOpen { name: String, shell: Option<String>, writable: bool },
    /// Keystrokes. Guests' input only reaches writable terminals.
    TermInput { id: u32, data: String },
    /// Host: the terminal's size changed.
    TermResize { id: u32, cols: u16, rows: u16 },
    /// Host: kill the terminal.
    TermClose { id: u32 },
    Leave,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FsOut {
    Dir(Vec<DirEntry>),
    Stat(DirEntry),
    Data(B64),
    Done,
}

/// Daemon -> extension.
#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CtlOut {
    Hello {
        role: Role,
        me: PeerId,
        session: String,
        invite: String,
        peers: Vec<PeerInfo>,
        root: Option<String>,
    },
    Peers { me: PeerId, peers: Vec<PeerInfo> },
    PeerJoined { peer: PeerInfo },
    PeerLeft { id: PeerId },
    /// Connection to the relay lost / regained (guests reconnect automatically).
    Status { connected: bool },
    Ended { reason: String },
    DocState { path: String, update: B64 },
    OpenFailed { path: String, error: String },
    Update { path: String, update: B64 },
    /// Host: please send `DocText` for this path.
    ReadDoc { path: String },
    FsResult {
        id: u64,
        ok: Option<FsOut>,
        err: Option<String>,
    },
    Presence { from: PeerId, path: String, data: String },
    Save { path: String },
    LangRequest {
        from: PeerId,
        id: u64,
        method: String,
        args: String,
    },
    LangResponse {
        id: u64,
        ok: Option<String>,
        err: Option<String>,
    },
    Diagnostics { path: String, json: String },
    /// Host: a guest's file change passed the sandbox; carry it out through
    /// the editor and answer with `FsApplied`.
    FsApply { id: u64, op: FsOp },
    FsChanged { created: Vec<String>, changed: Vec<String>, removed: Vec<String> },
    TermOpened { id: u32, name: String, writable: bool },
    TermOutput { id: u32, data: B64 },
    TermClosed { id: u32, code: Option<u32> },
    Error { message: String },
}

/// Accept control connections forever. Each must authenticate with `token`
/// in its first line; a new connection replaces the previous one.
pub async fn accept_loop(listener: TcpListener, token: String, events: mpsc::UnboundedSender<Event>) {
    let mut next_id = 0u64;
    loop {
        let Ok((stream, addr)) = listener.accept().await else { continue };
        if !addr.ip().is_loopback() {
            continue;
        }
        next_id += 1;
        let conn = next_id;
        let token = token.clone();
        let events = events.clone();
        tokio::spawn(async move {
            let _ = stream.set_nodelay(true);
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            match lines.next_line().await {
                Ok(Some(l)) if matches!(serde_json::from_str(&l), Ok(CtlIn::Auth { token: t }) if t == token) => {}
                _ => {
                    warn!("control connection failed authentication");
                    return;
                }
            }
            info!(conn, "extension connected");
            let (tx, mut rx) = mpsc::unbounded_channel::<String>();
            tokio::spawn(async move {
                while let Some(mut line) = rx.recv().await {
                    line.push('\n');
                    if write.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                }
            });
            if events.send(Event::CtlConnected(conn, tx)).is_err() {
                return;
            }
            while let Ok(Some(line)) = lines.next_line().await {
                match serde_json::from_str::<CtlIn>(&line) {
                    Ok(msg) => {
                        if events.send(Event::Ctl(conn, msg)).is_err() {
                            return;
                        }
                    }
                    Err(e) => warn!("bad control message: {e}"),
                }
            }
            info!(conn, "extension disconnected");
            let _ = events.send(Event::CtlDisconnected(conn));
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_extension_messages() {
        let m: CtlIn = serde_json::from_str(r#"{"t":"update","path":"a.cs","update":"AQI="}"#).unwrap();
        assert!(matches!(m, CtlIn::Update { ref path, ref update } if path == "a.cs" && update.0 == [1, 2]));
        let m: CtlIn = serde_json::from_str(r#"{"t":"fs","id":3,"op":{"readDir":"src"}}"#).unwrap();
        assert!(matches!(m, CtlIn::Fs { id: 3, op: FsOp::ReadDir(ref p) } if p == "src"));
        let m: CtlIn =
            serde_json::from_str(r#"{"t":"langResponse","to":2,"id":9,"ok":"[]","err":null}"#).unwrap();
        assert!(matches!(m, CtlIn::LangResponse { to: 2, id: 9, .. }));
        let m: CtlIn = serde_json::from_str(r#"{"t":"fs","id":4,"op":{"rename":{"from":"a","to":"b","overwrite":false}}}"#).unwrap();
        assert!(matches!(m, CtlIn::Fs { id: 4, op: FsOp::Rename { .. } }));
        let m: CtlIn = serde_json::from_str(r#"{"t":"fsNotify","removed":["a"]}"#).unwrap();
        assert!(matches!(m, CtlIn::FsNotify { ref removed, ref created, .. } if removed == &["a"] && created.is_empty()));
        let m: CtlIn = serde_json::from_str(r#"{"t":"termOpen","name":"bash","shell":null,"writable":false}"#).unwrap();
        assert!(matches!(m, CtlIn::TermOpen { writable: false, .. }));
    }

    #[test]
    fn serializes_daemon_messages() {
        let s = serde_json::to_string(&CtlOut::DocState { path: "a".into(), update: B64(vec![1, 2]) }).unwrap();
        assert_eq!(s, r#"{"t":"docState","path":"a","update":"AQI="}"#);
        let s = serde_json::to_string(&CtlOut::PeerLeft { id: 4 }).unwrap();
        assert_eq!(s, r#"{"t":"peerLeft","id":4}"#);
    }
}
