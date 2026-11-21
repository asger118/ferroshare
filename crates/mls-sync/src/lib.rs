//! CRDT document store.
//!
//! Every participant holds a replica of each shared document. Replicas
//! converge regardless of message order or duplication, which is what removes
//! the "weird sync" class of bugs: there is no central sequencing to get out
//! of step, and the periodic state-vector exchange ([`DocStore::state_vector`]
//! / [`DocStore::diff_since`]) repairs any lost update.
//!
//! Offsets are UTF-16 code units, matching VS Code's document model, so a
//! guest typing an emoji can't shift everyone else's cursor by a byte.
//!
//! The data layout (`Text` root named `"content"`) is compatible with Yjs, so
//! the VS Code extension can hold a JS replica of the same document.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, GetString, Observable, OffsetKind, Options, Out, ReadTxn, StateVector, Text,
    TextRef, Transact, Update,
};

const TEXT_ROOT: &str = "content";
const LOCAL_ORIGIN: &str = "local";

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("document not open: {0}")]
    NotOpen(String),
    #[error("document already open: {0}")]
    AlreadyOpen(String),
    #[error("invalid update: {0}")]
    BadUpdate(String),
    #[error("edit out of range: offset {offset} + {len} > length {doc_len}")]
    OutOfRange { offset: u32, len: u32, doc_len: u32 },
}

/// A single text change in UTF-16 offsets. When a list of edits is returned,
/// apply them **in order**; each offset is relative to the text after the
/// previous edit was applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextEdit {
    pub offset: u32,
    pub delete: u32,
    pub insert: String,
}

struct Entry {
    doc: Doc,
    text: TextRef,
    /// Edits produced by the most recent remote transaction.
    pending: Arc<Mutex<Vec<TextEdit>>>,
}

#[derive(Default)]
pub struct DocStore {
    docs: HashMap<String, Entry>,
}

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

impl DocStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn new_entry() -> Entry {
        let doc = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        let text = doc.get_or_insert_text(TEXT_ROOT);
        let pending: Arc<Mutex<Vec<TextEdit>>> = Arc::default();
        let sink = pending.clone();
        text.observe("mls-edits", move |txn, event| {
            // Only remote changes need to be pushed into an editor; local ones
            // came *from* the editor.
            if txn
                .origin()
                .is_some_and(|o| o.as_ref() == LOCAL_ORIGIN.as_bytes())
            {
                return;
            }
            let mut out = sink.lock().unwrap();
            let mut pos = 0u32;
            for d in event.delta(txn) {
                match d {
                    yrs::types::Delta::Retain(n, _) => pos += n,
                    yrs::types::Delta::Deleted(n) => out.push(TextEdit {
                        offset: pos,
                        delete: *n,
                        insert: String::new(),
                    }),
                    yrs::types::Delta::Inserted(Out::Any(Any::String(s)), _) => {
                        out.push(TextEdit {
                            offset: pos,
                            delete: 0,
                            insert: s.to_string(),
                        });
                        pos += utf16_len(s);
                    }
                    yrs::types::Delta::Inserted(..) => {} // non-text embeds: unused
                }
            }
        });
        Entry { doc, text, pending }
    }

    /// Host only: create a document from file contents on disk. Must happen
    /// exactly once per document per session — every other replica loads the
    /// result via [`DocStore::load`]. Seeding twice would duplicate the text.
    /// Returns the full state to send to peers.
    pub fn create(&mut self, path: &str, contents: &str) -> Result<Vec<u8>, SyncError> {
        if self.docs.contains_key(path) {
            return Err(SyncError::AlreadyOpen(path.into()));
        }
        let e = Self::new_entry();
        {
            let mut txn = e.doc.transact_mut_with(LOCAL_ORIGIN);
            e.text.insert(&mut txn, 0, contents);
        }
        let state = e.doc.transact().encode_state_as_update_v1(&StateVector::default());
        self.docs.insert(path.into(), e);
        Ok(state)
    }

    /// Load a document from a peer's full state (or merge into an existing
    /// replica). Returns edits to apply to an already-open editor.
    pub fn load(&mut self, path: &str, state: &[u8]) -> Result<Vec<TextEdit>, SyncError> {
        if !self.docs.contains_key(path) {
            self.docs.insert(path.into(), Self::new_entry());
        }
        self.apply_remote(path, state)
    }

    pub fn is_open(&self, path: &str) -> bool {
        self.docs.contains_key(path)
    }

    pub fn close(&mut self, path: &str) -> bool {
        self.docs.remove(path).is_some()
    }

    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.docs.keys().map(String::as_str)
    }

    fn entry(&self, path: &str) -> Result<&Entry, SyncError> {
        self.docs
            .get(path)
            .ok_or_else(|| SyncError::NotOpen(path.into()))
    }

    pub fn text(&self, path: &str) -> Result<String, SyncError> {
        let e = self.entry(path)?;
        Ok(e.text.get_string(&e.doc.transact()))
    }

    /// Apply an edit made locally (e.g. typed in this peer's editor).
    /// Returns the incremental update to broadcast.
    pub fn apply_local(&mut self, path: &str, edit: &TextEdit) -> Result<Vec<u8>, SyncError> {
        let e = self.entry(path)?;
        let mut txn = e.doc.transact_mut_with(LOCAL_ORIGIN);
        let doc_len = e.text.len(&txn);
        if edit.offset.checked_add(edit.delete).is_none_or(|end| end > doc_len) {
            return Err(SyncError::OutOfRange {
                offset: edit.offset,
                len: edit.delete,
                doc_len,
            });
        }
        if edit.delete > 0 {
            e.text.remove_range(&mut txn, edit.offset, edit.delete);
        }
        if !edit.insert.is_empty() {
            e.text.insert(&mut txn, edit.offset, &edit.insert);
        }
        Ok(txn.encode_update_v1())
    }

    /// Apply an update received from a peer. Idempotent and order-independent.
    /// Returns the resulting edits (in order) for this peer's editor.
    pub fn apply_remote(&mut self, path: &str, update: &[u8]) -> Result<Vec<TextEdit>, SyncError> {
        let e = self.entry(path)?;
        let update = Update::decode_v1(update).map_err(|err| SyncError::BadUpdate(err.to_string()))?;
        {
            let mut txn = e.doc.transact_mut();
            txn.apply_update(update)
                .map_err(|err| SyncError::BadUpdate(err.to_string()))?;
        }
        Ok(std::mem::take(&mut *e.pending.lock().unwrap()))
    }

    /// Full document state (to send to a newly joined peer).
    pub fn full_state(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        self.diff_since(path, &[])
    }

    /// Encoded state vector — "what I have" — for anti-entropy.
    pub fn state_vector(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        use yrs::updates::encoder::Encode;
        Ok(self.entry(path)?.doc.transact().state_vector().encode_v1())
    }

    /// Everything we have that a peer with `state_vector` is missing.
    /// An empty slice means "everything".
    pub fn diff_since(&self, path: &str, state_vector: &[u8]) -> Result<Vec<u8>, SyncError> {
        let e = self.entry(path)?;
        let sv = if state_vector.is_empty() {
            StateVector::default()
        } else {
            StateVector::decode_v1(state_vector).map_err(|err| SyncError::BadUpdate(err.to_string()))?
        };
        Ok(e.doc.transact().encode_state_as_update_v1(&sv))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(offset: u32, delete: u32, insert: &str) -> TextEdit {
        TextEdit { offset, delete, insert: insert.into() }
    }

    /// Simulates an editor buffer receiving remote edits.
    fn apply_to_buffer(buf: &str, edits: &[TextEdit]) -> String {
        let mut units: Vec<u16> = buf.encode_utf16().collect();
        for e in edits {
            let ins: Vec<u16> = e.insert.encode_utf16().collect();
            let (o, d) = (e.offset as usize, e.delete as usize);
            units.splice(o..o + d, ins);
        }
        String::from_utf16(&units).unwrap()
    }

    fn host_and_guest(contents: &str) -> (DocStore, DocStore) {
        let mut host = DocStore::new();
        let state = host.create("a.cs", contents).unwrap();
        let mut guest = DocStore::new();
        guest.load("a.cs", &state).unwrap();
        (host, guest)
    }

    #[test]
    fn guest_loads_host_contents() {
        let (_, guest) = host_and_guest("class A {}\r\n");
        assert_eq!(guest.text("a.cs").unwrap(), "class A {}\r\n");
    }

    #[test]
    fn cannot_seed_twice() {
        let mut host = DocStore::new();
        host.create("a", "x").unwrap();
        assert!(matches!(host.create("a", "x"), Err(SyncError::AlreadyOpen(_))));
    }

    #[test]
    fn concurrent_edits_converge() {
        let (mut host, mut guest) = host_and_guest("hello world");
        // Both type at the same time, before seeing each other's change.
        let u1 = host.apply_local("a.cs", &edit(5, 0, ",")).unwrap();
        let u2 = guest.apply_local("a.cs", &edit(11, 0, "!")).unwrap();
        let u3 = guest.apply_local("a.cs", &edit(0, 5, "HELLO")).unwrap();
        // Deliver out of order and duplicated.
        host.apply_remote("a.cs", &u3).unwrap();
        host.apply_remote("a.cs", &u2).unwrap();
        host.apply_remote("a.cs", &u2).unwrap();
        guest.apply_remote("a.cs", &u1).unwrap();
        assert_eq!(host.text("a.cs").unwrap(), guest.text("a.cs").unwrap());
        // Where "," lands relative to the concurrent replacement is decided
        // deterministically by the CRDT; what matters is that nothing is lost.
        let t = host.text("a.cs").unwrap();
        assert!(t == "HELLO, world!" || t == ",HELLO world!", "got {t:?}");
    }

    #[test]
    fn remote_edits_reproduce_text_in_editor_buffer() {
        let (mut host, mut guest) = host_and_guest("abc\ndef\n");
        let mut guest_buffer = guest.text("a.cs").unwrap();
        let u = host.apply_local("a.cs", &edit(4, 3, "XYZ")).unwrap();
        let u2 = host.apply_local("a.cs", &edit(0, 0, "// hi\n")).unwrap();
        let mut both = guest.apply_remote("a.cs", &u).unwrap();
        both.extend(guest.apply_remote("a.cs", &u2).unwrap());
        guest_buffer = apply_to_buffer(&guest_buffer, &both);
        assert_eq!(guest_buffer, host.text("a.cs").unwrap());
        assert_eq!(guest_buffer, "// hi\nabc\nXYZ\n");
    }

    #[test]
    fn local_edits_are_not_echoed_back() {
        let (mut host, _) = host_and_guest("x");
        host.apply_local("a.cs", &edit(1, 0, "y")).unwrap();
        // A remote no-op update yields no edits; the local edit was not queued.
        let empty = host.diff_since("a.cs", &host.state_vector("a.cs").unwrap()).unwrap();
        assert!(host.apply_remote("a.cs", &empty).unwrap().is_empty());
    }

    #[test]
    fn utf16_offsets_with_emoji() {
        // "😀" is 2 UTF-16 units; offset 2 is right after it.
        let (mut host, mut guest) = host_and_guest("😀b");
        let mut buf = guest.text("a.cs").unwrap();
        let u = host.apply_local("a.cs", &edit(2, 1, "é")).unwrap();
        buf = apply_to_buffer(&buf, &guest.apply_remote("a.cs", &u).unwrap());
        assert_eq!(buf, "😀é");
        assert_eq!(guest.text("a.cs").unwrap(), "😀é");
    }

    #[test]
    fn anti_entropy_repairs_lost_update() {
        let (mut host, mut guest) = host_and_guest("abc");
        let _lost = host.apply_local("a.cs", &edit(3, 0, "def")).unwrap(); // never delivered
        // Periodic sync: guest says what it has, host replies with the gap.
        let sv = guest.state_vector("a.cs").unwrap();
        let repair = host.diff_since("a.cs", &sv).unwrap();
        guest.apply_remote("a.cs", &repair).unwrap();
        assert_eq!(guest.text("a.cs").unwrap(), "abcdef");
    }

    #[test]
    fn out_of_range_edit_rejected() {
        let (mut host, _) = host_and_guest("abc");
        assert!(matches!(
            host.apply_local("a.cs", &edit(2, 5, "")),
            Err(SyncError::OutOfRange { .. })
        ));
    }

    #[test]
    fn bad_update_rejected() {
        let (mut host, _) = host_and_guest("abc");
        assert!(host.apply_remote("a.cs", &[0xff, 0xff, 0xff]).is_err());
    }
}
