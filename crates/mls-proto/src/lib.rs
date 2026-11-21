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

/// Read-only file-system operations a guest may ask the host for.
/// Paths are workspace-relative with `/` separators; `""` is the root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FsOp {
    ReadDir(String),
    Stat(String),
    /// Raw bytes, for files that aren't shared as text documents (images…).
    Read(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum FsReply {
    Dir(Vec<DirEntry>),
    Stat(DirEntry),
    Data(#[serde(with = "serde_bytes")] Vec<u8>),
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
}
