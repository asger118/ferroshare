//! End-to-end encryption of everything peers say to each other.
//!
//! The host generates a random 256-bit session key and puts it in the invite
//! link's fragment (`wss://relay#session.token.KEY`). The key is never sent to
//! the relay, so the relay (and anything in front of it, like Cloudflare) only
//! ever sees ciphertext. It still sees routing metadata: who is in the session,
//! their display names, and message sizes and timing.
//!
//! Each `AppMsg` payload is sealed with XChaCha20-Poly1305:
//!
//! ```text
//! sealed  = VERSION(1) || nonce(24) || AEAD(key, nonce, counter_le(8) || payload, aad)
//! aad     = "mls-e2e-v1" || session || sender_peer_id_le(4)
//! ```
//!
//! * The random 192-bit nonce makes nonce reuse a non-issue.
//! * The AAD binds every message to this session and to its sender, so a
//!   relay can't move a message to another session or relabel who sent it.
//! * The per-sender counter must strictly increase, so a relay can't replay
//!   old messages (for example a stale edit or a second "save").
//!
//! A relay can still drop or delay messages. CRDT anti-entropy repairs drops.

use std::collections::HashMap;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce};
use mls_proto::PeerId;

const VERSION: u8 = 1;
const NONCE_LEN: usize = 24;
const DOMAIN: &[u8] = b"mls-e2e-v1";

#[derive(Clone)]
pub struct SessionKey([u8; 32]);

impl SessionKey {
    pub fn generate() -> Self {
        Self(rand::random())
    }

    pub fn parse(s: &str) -> anyhow::Result<Self> {
        let bytes = URL_SAFE_NO_PAD
            .decode(s)
            .map_err(|_| anyhow::anyhow!("invalid encryption key in invite link"))?;
        let key: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid encryption key in invite link"))?;
        Ok(Self(key))
    }

    pub fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.0)
    }
}

impl std::fmt::Debug for SessionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionKey(..)")
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum OpenError {
    /// Wrong key, tampered with, or relabelled by the relay.
    Forged,
    /// Authentic, but already seen (or older than something already seen).
    Replay,
}

/// Seals outgoing and opens incoming payloads for one participant.
pub struct Sealer {
    cipher: XChaCha20Poly1305,
    session: String,
    /// Our relay-assigned peer id. Changes when a guest reconnects.
    pub me: PeerId,
    sent: u64,
    seen: HashMap<PeerId, u64>,
}

impl Sealer {
    pub fn new(key: &SessionKey, session: &str, me: PeerId) -> Self {
        Self {
            cipher: XChaCha20Poly1305::new(&Key::from(key.0)),
            session: session.into(),
            me,
            sent: 0,
            seen: HashMap::new(),
        }
    }

    fn aad(&self, sender: PeerId) -> Vec<u8> {
        let mut aad = Vec::with_capacity(DOMAIN.len() + self.session.len() + 4);
        aad.extend_from_slice(DOMAIN);
        aad.extend_from_slice(self.session.as_bytes());
        aad.extend_from_slice(&sender.to_le_bytes());
        aad
    }

    pub fn seal(&mut self, payload: &[u8]) -> Vec<u8> {
        self.sent += 1;
        let nonce: [u8; NONCE_LEN] = rand::random();
        let mut plain = Vec::with_capacity(8 + payload.len());
        plain.extend_from_slice(&self.sent.to_le_bytes());
        plain.extend_from_slice(payload);
        let aad = self.aad(self.me);
        let ct = self
            .cipher
            .encrypt(&XNonce::from(nonce), Payload { msg: &plain, aad: &aad })
            .expect("XChaCha20-Poly1305 encryption cannot fail for in-memory buffers");
        let mut out = Vec::with_capacity(1 + NONCE_LEN + ct.len());
        out.push(VERSION);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        out
    }

    pub fn open(&mut self, from: PeerId, sealed: &[u8]) -> Result<Vec<u8>, OpenError> {
        if sealed.len() < 1 + NONCE_LEN || sealed[0] != VERSION {
            return Err(OpenError::Forged);
        }
        let nonce: [u8; NONCE_LEN] = sealed[1..1 + NONCE_LEN].try_into().unwrap();
        let aad = self.aad(from);
        let mut plain = self
            .cipher
            .decrypt(&XNonce::from(nonce), Payload { msg: &sealed[1 + NONCE_LEN..], aad: &aad })
            .map_err(|_| OpenError::Forged)?;
        if plain.len() < 8 {
            return Err(OpenError::Forged);
        }
        let counter = u64::from_le_bytes(plain[..8].try_into().unwrap());
        let last = self.seen.entry(from).or_insert(0);
        if counter <= *last {
            return Err(OpenError::Replay);
        }
        *last = counter;
        plain.drain(..8);
        Ok(plain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (Sealer, Sealer) {
        let key = SessionKey::generate();
        (Sealer::new(&key, "sess", 1), Sealer::new(&key, "sess", 2))
    }

    #[test]
    fn roundtrip() {
        let (mut a, mut b) = pair();
        for msg in [&b"hello"[..], b"", &[0u8; 100_000]] {
            let s = a.seal(msg);
            assert_eq!(b.open(1, &s).unwrap(), msg);
        }
    }

    #[test]
    fn ciphertext_hides_plaintext() {
        let (mut a, _) = pair();
        let s = a.seal(b"super secret source code");
        assert!(!s.windows(6).any(|w| w == b"secret"));
        // Same plaintext twice gives different ciphertexts.
        assert_ne!(a.seal(b"x"), a.seal(b"x"));
    }

    #[test]
    fn wrong_key_rejected() {
        let (mut a, _) = pair();
        let mut other = Sealer::new(&SessionKey::generate(), "sess", 2);
        assert_eq!(other.open(1, &a.seal(b"hi")), Err(OpenError::Forged));
    }

    #[test]
    fn relabelled_sender_rejected() {
        let (mut a, mut b) = pair();
        assert_eq!(b.open(3, &a.seal(b"hi")), Err(OpenError::Forged));
    }

    #[test]
    fn other_session_rejected() {
        let key = SessionKey::generate();
        let mut a = Sealer::new(&key, "sess-a", 1);
        let mut b = Sealer::new(&key, "sess-b", 2);
        assert_eq!(b.open(1, &a.seal(b"hi")), Err(OpenError::Forged));
    }

    #[test]
    fn tampering_rejected() {
        let (mut a, mut b) = pair();
        let s = a.seal(b"hello");
        for i in 0..s.len() {
            let mut t = s.clone();
            t[i] ^= 0x01;
            assert_eq!(b.open(1, &t), Err(OpenError::Forged), "byte {i}");
        }
        assert_eq!(b.open(1, &s[..10]), Err(OpenError::Forged));
        assert_eq!(b.open(1, &s).unwrap(), b"hello");
    }

    #[test]
    fn replay_rejected() {
        let (mut a, mut b) = pair();
        let first = a.seal(b"1");
        let second = a.seal(b"2");
        assert!(b.open(1, &first).is_ok());
        assert!(b.open(1, &second).is_ok());
        assert_eq!(b.open(1, &second), Err(OpenError::Replay));
        assert_eq!(b.open(1, &first), Err(OpenError::Replay));
    }

    #[test]
    fn reconnected_sender_keeps_working() {
        let (mut a, mut b) = pair();
        assert!(b.open(1, &a.seal(b"before")).is_ok());
        a.me = 7; // the relay gave the guest a new id after a reconnect
        assert_eq!(b.open(7, &a.seal(b"after")).unwrap(), b"after");
    }

    #[test]
    fn key_encoding_roundtrip() {
        let k = SessionKey::generate();
        let s = k.encode();
        assert_eq!(s.len(), 43);
        assert!(!s.contains('.') && !s.contains('#'));
        assert_eq!(SessionKey::parse(&s).unwrap().0, k.0);
        assert!(SessionKey::parse("short").is_err());
        assert!(SessionKey::parse("!!!").is_err());
    }
}
