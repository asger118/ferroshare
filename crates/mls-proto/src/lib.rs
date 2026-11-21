//! Wire protocol shared by the relay and the daemons.
//!
//! Two layers:
//! - [`RelayMsg`]: what the relay understands (sessions, peers, routing).
//!   Payloads are opaque bytes so the relay can never corrupt document state,
//!   and so end-to-end encryption can be layered on without touching the relay.
//! - [`AppMsg`]: what peers say to each other inside `Envelope::payload`.

use serde::{Deserialize, Serialize};

pub type PeerId = u32;

/// Protocol version; bumped on incompatible changes. Peers with a different
/// major version are rejected with a clear error instead of misbehaving.
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    Host,
    Guest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerInfo {
    pub id: PeerId,
    pub name: String,
    pub role: Role,
}

/// Frames exchanged between a peer and the relay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum RelayMsg {
    // ---- peer -> relay ----
    /// Host opens a new session. Relay answers with `SessionCreated`.
    CreateSession { version: u32, name: String },
    /// Guest joins an existing session using the secret from the invite link.
    JoinSession {
        version: u32,
        session: String,
        token: String,
        name: String,
    },
    /// Route a payload. `to: None` = broadcast to every other peer.
    Send {
        to: Option<PeerId>,
        #[serde(with = "serde_bytes")]
        payload: Vec<u8>,
    },
    Ping,

    // ---- relay -> peer ----
    SessionCreated {
        session: String,
        token: String,
        you: PeerId,
    },
    Joined {
        you: PeerId,
        peers: Vec<PeerInfo>,
    },
    PeerJoined(PeerInfo),
    PeerLeft(PeerId),
    /// Host disconnected; the session is over.
    SessionEnded,
    Envelope {
        from: PeerId,
        #[serde(with = "serde_bytes")]
        payload: Vec<u8>,
    },
    Pong,
    Error(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    File,
    Dir,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub kind: FileKind,
    pub size: u64,
    /// Milliseconds since the Unix epoch.
    pub mtime: u64,
}

/// Binary data: raw bytes in MessagePack, base64 in JSON (the extension's
/// control channel), so the same types serve both.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct Bytes(pub Vec<u8>);

impl std::fmt::Debug for Bytes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Bytes({})", self.0.len())
    }
}

impl Serialize for Bytes {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use base64::Engine;
        if s.is_human_readable() {
            s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(&self.0))
        } else {
            s.serialize_bytes(&self.0)
        }
    }
}

impl<'de> Deserialize<'de> for Bytes {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use base64::Engine;
        if d.is_human_readable() {
            let s = String::deserialize(d)?;
            base64::engine::general_purpose::STANDARD.decode(s).map(Bytes).map_err(serde::de::Error::custom)
        } else {
            serde_bytes::ByteBuf::deserialize(d).map(|b| Bytes(b.into_vec()))
        }
    }
}

/// File-system operations a guest may ask the host for.
/// Paths are workspace-relative with `/` separators; `""` is the root.
///
/// Errors that VS Code needs to tell apart start with a code:
/// `FileNotFound:`, `FileExists:`, `NoPermissions:`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FsOp {
    ReadDir(String),
    Stat(String),
    /// Raw bytes, for files that aren't shared as text documents (images…).
    Read(String),
    /// Create or overwrite a file that isn't open as a shared document.
    Write { path: String, data: Bytes, create: bool, overwrite: bool },
    CreateDir(String),
    Delete { path: String, recursive: bool },
    Rename { from: String, to: String, overwrite: bool },
}

impl FsOp {
    /// Changes the workspace, so the host's editor has to carry it out.
    pub fn is_mutation(&self) -> bool {
        matches!(self, FsOp::Write { .. } | FsOp::CreateDir(_) | FsOp::Delete { .. } | FsOp::Rename { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum FsReply {
    Dir(Vec<DirEntry>),
    Stat(DirEntry),
    Data(#[serde(with = "serde_bytes")] Vec<u8>),
    /// A mutation succeeded.
    Done,
}

/// Peer-to-peer application messages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum AppMsg {
    Fs { id: u64, op: FsOp },
    FsResult { id: u64, result: Result<FsReply, String> },

    /// Ask the host for a text document. Host replies with `DocState` or
    /// `OpenFailed` (e.g. the file is binary).
    OpenDoc { path: String },
    DocState {
        path: String,
        #[serde(with = "serde_bytes")]
        update: Vec<u8>,
    },
    OpenFailed { path: String, error: String },
    /// Incremental CRDT update for a document.
    DocUpdate {
        path: String,
        #[serde(with = "serde_bytes")]
        update: Vec<u8>,
    },
    /// Anti-entropy: "this is what I have". The receiver replies with a
    /// `DocUpdate` holding whatever the sender is missing and, if
    /// `want_reply`, its own `SyncStep1` so the repair goes both ways. Sent
    /// periodically, so a lost message can never cause permanent divergence.
    SyncStep1 {
        path: String,
        #[serde(with = "serde_bytes")]
        state_vector: Vec<u8>,
        want_reply: bool,
    },

    /// Cursor/selection of a peer (opaque JSON from the extension; uses
    /// CRDT-relative positions so it stays put while others type).
    Presence { path: String, data: String },
    /// A guest pressed save; the host saves through its own editor so
    /// format-on-save etc. run exactly as for the host.
    Save { path: String },

    /// Forwarded language-feature request (completion, hover, definition…).
    /// Opaque to the daemons; the host's editor answers it using its own
    /// language extensions.
    LangRequest { id: u64, method: String, args: String },
    LangResponse { id: u64, result: Result<String, String> },
    /// Host pushes diagnostics (JSON) for a document.
    Diagnostics { path: String, json: String },

    /// Host: files or folders were created, changed or removed (by a guest
    /// or on the host). Shared documents at or below a removed path are gone.
    /// A rename is listed in `renamed`, and also as removed and created for
    /// older peers. Shared documents below a renamed path live on under the
    /// new name.
    FsChanged {
        created: Vec<String>,
        changed: Vec<String>,
        removed: Vec<String>,
        #[serde(default)]
        renamed: Vec<(String, String)>,
    },

    /// Host started sharing a terminal. `writable`: guests may type in it.
    TermOpened { id: u32, name: String, writable: bool },
    /// Terminal output (raw bytes from the pty).
    TermOutput { id: u32, data: Bytes },
    /// Guest typed into a writable terminal.
    TermInput { id: u32, data: Bytes },
    /// The terminal's process exited or the host closed it.
    TermClosed { id: u32, code: Option<u32> },
    /// Guest: the size of my tab for terminal `id` (0×0 = I closed it).
    /// The shell is sized to fit one person's tab: whoever typed in it last,
    /// or asked for it with `TermFit`. The host's tab is the fallback.
    TermResize { id: u32, cols: u16, rows: u16 },
    /// Guest: size the shell to fit my tab.
    TermFit { id: u32 },
    /// Host: the shell's current size, and whose tab it fits.
    TermSize { id: u32, cols: u16, rows: u16, by: PeerId },
}

#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    #[error("encode: {0}")]
    Encode(#[from] rmp_serde::encode::Error),
    #[error("decode: {0}")]
    Decode(#[from] rmp_serde::decode::Error),
}

pub fn encode<T: Serialize>(msg: &T) -> Result<Vec<u8>, CodecError> {
    Ok(rmp_serde::to_vec_named(msg)?)
}

pub fn decode<'a, T: Deserialize<'a>>(bytes: &'a [u8]) -> Result<T, CodecError> {
    Ok(rmp_serde::from_slice(bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_roundtrip() {
        let m = RelayMsg::Send {
            to: Some(3),
            payload: vec![1, 2, 3],
        };
        assert_eq!(decode::<RelayMsg>(&encode(&m).unwrap()).unwrap(), m);
    }

    #[test]
    fn app_roundtrip() {
        let m = AppMsg::LangResponse {
            id: 7,
            result: Err("nope".into()),
        };
        assert_eq!(decode::<AppMsg>(&encode(&m).unwrap()).unwrap(), m);
    }

    #[test]
    fn bytes_are_raw_in_msgpack_and_base64_in_json() {
        let m = AppMsg::TermOutput { id: 1, data: Bytes(b"hi".to_vec()) };
        let packed = encode(&m).unwrap();
        assert!(packed.windows(2).any(|w| w == b"hi"));
        assert_eq!(decode::<AppMsg>(&packed).unwrap(), m);

        let op = FsOp::Write { path: "a".into(), data: Bytes(vec![1, 2]), create: true, overwrite: false };
        let json = serde_json::to_string(&op).unwrap();
        assert_eq!(json, r#"{"write":{"path":"a","data":"AQI=","create":true,"overwrite":false}}"#);
        assert_eq!(serde_json::from_str::<FsOp>(&json).unwrap(), op);
    }

    /// Peers from before `renamed` existed must still be understood.
    #[test]
    fn fs_changed_without_renamed_decodes() {
        #[derive(Serialize)]
        enum Old {
            FsChanged { created: Vec<String>, changed: Vec<String>, removed: Vec<String> },
        }
        let old = encode(&Old::FsChanged { created: vec!["a".into()], changed: vec![], removed: vec![] }).unwrap();
        let m = decode::<AppMsg>(&old).unwrap();
        assert_eq!(m, AppMsg::FsChanged { created: vec!["a".into()], changed: vec![], removed: vec![], renamed: vec![] });
    }
}
