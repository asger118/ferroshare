//! The daemon's state machine. All state lives on one task; I/O tasks feed
//! it [`Event`]s, so there are no locks and no ordering surprises.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{Duration, Instant};

use mls_proto::{AppMsg, Bytes, FsOp, FsReply, PeerId, PeerInfo, RelayMsg, Role, decode, encode};
use mls_sync::DocStore;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::Event;
use crate::ctl::{B64, CtlIn, CtlOut, FsOut};
use crate::fs::Workspace;
use crate::relay::RelayEvent;
use crate::term::{self, Pty};

/// How often guests run an anti-entropy round with the host.
pub const SYNC_EVERY: Duration = Duration::from_secs(3);
/// Exit if no extension is attached for this long.
const ORPHAN_TIMEOUT: Duration = Duration::from_secs(120);
/// Host: if the editor doesn't hand over a buffer in time, seed from disk.
const SEED_TIMEOUT: Duration = Duration::from_secs(5);
/// A shared terminal is never made smaller than this, whatever tab sizes
/// people report.
const MIN_COLS: u16 = 20;
const MIN_ROWS: u16 = 5;

/// Yjs/yrs encode an update containing nothing as two zero bytes.
fn is_empty_update(u: &[u8]) -> bool {
    u.len() <= 2
}

/// A guest's file change waiting for the host editor to carry it out.
struct PendingFs {
    from: PeerId,
    id: u64,
    op: FsOp,
    /// `Write` to a path that didn't exist yet.
    creates: bool,
}

/// A shared terminal. The host holds the pty; everyone keeps the scrollback
/// so it can be replayed to a reloaded editor.
struct Terminal {
    name: String,
    writable: bool,
    scrollback: Vec<u8>,
    pty: Option<Pty>,
    /// Current size of the shell, and whose tab it fits.
    size: (u16, u16),
    by: PeerId,
    /// Host: the size of each participant's open tab.
    views: BTreeMap<PeerId, (u16, u16)>,
    /// Host: whose tab the shell should fit: whoever typed in it last or
    /// asked for it. Back to the host when they close their tab or leave.
    driver: PeerId,
    /// Guest: the size of my tab, re-sent after a reconnect.
    mine: Option<(u16, u16)>,
}

impl Terminal {
    fn new(name: String, writable: bool, pty: Option<Pty>, host: PeerId) -> Self {
        Self { name, writable, scrollback: Vec::new(), pty, size: (80, 24), by: host, views: BTreeMap::new(), driver: host, mine: None }
    }
}

/// Input that is someone typing, not their terminal widget answering the
/// shell: cursor position reports (`ESC[row;colR`) and focus in/out
/// (`ESC[I`, `ESC[O`) arrive without anyone touching the keyboard.
fn is_typing(mut s: &[u8]) -> bool {
    while !s.is_empty() {
        let Some(rest) = s.strip_prefix(b"\x1b[") else { return true };
        if let Some(r) = rest.strip_prefix(b"I").or_else(|| rest.strip_prefix(b"O")) {
            s = r;
            continue;
        }
        let n = rest.iter().take_while(|c| c.is_ascii_digit() || **c == b';').count();
        if n == 0 || rest.get(n) != Some(&b'R') {
            return true;
        }
        s = &rest[n + 1..];
    }
    false
}

#[derive(Default)]
struct FsChanges {
    created: Vec<String>,
    changed: Vec<String>,
    removed: Vec<String>,
    renamed: Vec<(String, String)>,
}

impl FsChanges {
    fn of(op: &FsOp, creates: bool) -> Self {
        let mut c = Self::default();
        match op {
            FsOp::Write { path, .. } if creates => c.created.push(path.clone()),
            FsOp::Write { path, .. } => c.changed.push(path.clone()),
            FsOp::CreateDir(path) => c.created.push(path.clone()),
            FsOp::Delete { path, .. } => c.removed.push(path.clone()),
            FsOp::Rename { from, to, .. } => c.renamed.push((from.clone(), to.clone())),
            FsOp::ReadDir(_) | FsOp::Stat(_) | FsOp::Read(_) => {}
        }
        c
    }
}

/// `path` is `prefix` or inside it.
fn is_under(path: &str, prefix: &str) -> bool {
    path == prefix || path.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('/'))
}

/// Where `path` ends up when `from` is renamed to `to`.
fn moved(path: &str, from: &str, to: &str) -> Option<String> {
    is_under(path, from).then(|| format!("{to}{}", &path[from.len()..]))
}

struct Seeding {
    started: Instant,
    /// Guests waiting for this document.
    waiters: Vec<PeerId>,
}

pub struct Daemon {
    role: Role,
    me: PeerId,
    session: String,
    invite: String,
    peers: BTreeMap<PeerId, PeerInfo>,
    relay: mpsc::UnboundedSender<RelayMsg>,
    ctl: Option<(u64, mpsc::UnboundedSender<String>)>,
    ctl_lost_at: Option<Instant>,
    store: DocStore,
    /// Host only.
    workspace: Option<Workspace>,
    seeding: HashMap<String, Seeding>,
    /// Guest: documents the extension asked for that haven't arrived yet.
    requested: HashSet<String>,
    connected: bool,
    events: mpsc::UnboundedSender<Event>,
    /// Host: guest file changes the editor is carrying out, by local id.
    pending_fs: HashMap<u64, PendingFs>,
    next_fs: u64,
    terminals: BTreeMap<u32, Terminal>,
    next_term: u32,
}

pub struct Config {
    pub role: Role,
    pub me: PeerId,
    pub session: String,
    pub invite: String,
    pub peers: Vec<PeerInfo>,
    pub relay: mpsc::UnboundedSender<RelayMsg>,
    pub workspace: Option<Workspace>,
    /// For threads that report back (terminals).
    pub events: mpsc::UnboundedSender<Event>,
}

pub enum Flow {
    Continue,
    Exit,
}

impl Daemon {
    pub fn new(c: Config) -> Self {
        Self {
            role: c.role,
            me: c.me,
            session: c.session,
            invite: c.invite,
            peers: c.peers.into_iter().map(|p| (p.id, p)).collect(),
            relay: c.relay,
            ctl: None,
            ctl_lost_at: Some(Instant::now()),
            store: DocStore::new(),
            workspace: c.workspace,
            seeding: HashMap::new(),
            requested: HashSet::new(),
            connected: true,
            events: c.events,
            pending_fs: HashMap::new(),
            next_fs: 1,
            terminals: BTreeMap::new(),
            next_term: 1,
        }
    }

    pub async fn run(mut self, mut events: mpsc::UnboundedReceiver<Event>) {
        let mut tick = tokio::time::interval(SYNC_EVERY);
        loop {
            let flow = tokio::select! {
                e = events.recv() => match e {
                    Some(e) => self.handle(e),
                    None => Flow::Exit,
                },
                _ = tick.tick() => self.on_tick(),
            };
            if let Flow::Exit = flow {
                info!("daemon exiting");
                return;
            }
        }
    }

    pub fn handle(&mut self, e: Event) -> Flow {
        match e {
            Event::CtlConnected(id, tx) => {
                self.ctl = Some((id, tx));
                self.ctl_lost_at = None;
                self.on_ctl_attached();
                Flow::Continue
            }
            Event::CtlDisconnected(id) => {
                if self.ctl.as_ref().is_some_and(|(cur, _)| *cur == id) {
                    self.ctl = None;
                    self.ctl_lost_at = Some(Instant::now());
                }
                Flow::Continue
            }
            Event::Ctl(id, msg) => {
                if self.ctl.as_ref().is_some_and(|(cur, _)| *cur == id) {
                    self.on_ctl(msg)
                } else {
                    Flow::Continue
                }
            }
            Event::Relay(r) => self.on_relay(r),
            Event::TermOutput(id, data) => {
                self.on_term_output(id, data);
                Flow::Continue
            }
            Event::TermExited(id, code) => {
                self.close_terminal(id, code);
                Flow::Continue
            }
        }
    }

    // ---------------------------------------------------------------- output

    fn emit(&self, m: CtlOut) {
        if let Some((_, tx)) = &self.ctl {
            match serde_json::to_string(&m) {
                Ok(line) => {
                    let _ = tx.send(line);
                }
                Err(e) => warn!("could not serialize control message: {e}"),
            }
        }
    }

    fn send(&self, to: Option<PeerId>, m: &AppMsg) {
        match encode(m) {
            Ok(payload) => {
                let _ = self.relay.send(RelayMsg::Send { to, payload });
            }
            Err(e) => warn!("could not encode {m:?}: {e}"),
        }
    }

    fn host_id(&self) -> Option<PeerId> {
        self.peers.values().find(|p| p.role == Role::Host).map(|p| p.id)
    }

    fn to_host(&self, m: &AppMsg) {
        match self.host_id() {
            Some(h) => self.send(Some(h), m),
            None => warn!("no host in session; dropping {m:?}"),
        }
    }

    fn is_host(&self) -> bool {
        self.role == Role::Host
    }

    // ----------------------------------------------------------- extension

    fn on_ctl_attached(&mut self) {
        self.emit(CtlOut::Hello {
            role: self.role,
            me: self.me,
            session: self.session.clone(),
            invite: self.invite.clone(),
            peers: self.peers.values().cloned().collect(),
            root: self.workspace.as_ref().map(|w| w.root().display().to_string()),
        });
        if !self.connected {
            self.emit(CtlOut::Status { connected: false });
        }
        for (&id, t) in &self.terminals {
            self.emit(CtlOut::TermOpened { id, name: t.name.clone(), writable: t.writable });
            self.emit(CtlOut::TermSize { id, cols: t.size.0, rows: t.size.1, by: t.by });
            if !t.scrollback.is_empty() {
                self.emit(CtlOut::TermOutput { id, data: B64(t.scrollback.clone()) });
            }
        }
        // Host editor (re)attached: it must bind every shared document.
        if self.is_host() {
            let paths: Vec<String> = self.store.paths().map(String::from).collect();
            for path in paths {
                if let Ok(state) = self.store.full_state(&path) {
                    self.emit(CtlOut::DocState { path, update: B64(state) });
                }
            }
        }
    }

    fn on_ctl(&mut self, msg: CtlIn) -> Flow {
        match msg {
            CtlIn::Auth { .. } => {}
            CtlIn::Leave => return Flow::Exit,
            CtlIn::Open { path } => {
                if self.store.is_open(&path) {
                    if let Ok(state) = self.store.full_state(&path) {
                        self.emit(CtlOut::DocState { path, update: B64(state) });
                    }
                } else if self.is_host() {
                    self.start_seed(&path, None);
                } else if self.requested.insert(path.clone()) {
                    self.to_host(&AppMsg::OpenDoc { path });
                }
            }
            CtlIn::Close { path } => {
                // Host keeps its replica: other guests may still have it open.
                if !self.is_host() {
                    self.store.close(&path);
                    self.requested.remove(&path);
                }
            }
            CtlIn::Update { path, update } => match self.store.apply_remote(&path, &update.0) {
                Ok(_) => self.send(None, &AppMsg::DocUpdate { path, update: update.0 }),
                Err(e) => warn!("local update rejected: {e}"),
            },
            CtlIn::DocText { path, text } => {
                if self.is_host() {
                    self.finish_seed(&path, text);
                }
            }
            CtlIn::Fs { id, op } => {
                if self.is_host() {
                    // The host changes its own files directly, not through us.
                    let r = if op.is_mutation() { Err("not supported on the host".into()) } else { self.fs_op(&op) };
                    self.emit_fs_result(id, r);
                } else {
                    self.to_host(&AppMsg::Fs { id, op });
                }
            }
            CtlIn::FsApplied { id, err } => {
                if let Some(p) = self.pending_fs.remove(&id) {
                    let ok = err.is_none();
                    let result = err.map_or(Ok(FsReply::Done), Err);
                    self.send(Some(p.from), &AppMsg::FsResult { id: p.id, result });
                    if ok {
                        self.fs_changed(FsChanges::of(&p.op, p.creates));
                    }
                }
            }
            CtlIn::FsNotify { created, changed, removed, renamed } => {
                if self.is_host() {
                    self.fs_changed(FsChanges { created, changed, removed, renamed });
                }
            }
            CtlIn::TermOpen { name, shell, writable } => {
                if self.is_host() {
                    self.open_terminal(name, shell, writable);
                }
            }
            CtlIn::TermInput { id, data } => {
                if self.is_host() {
                    let typing = is_typing(data.as_bytes());
                    if let Some(pty) = self.terminals.get(&id).and_then(|t| t.pty.as_ref()) {
                        pty.write(data.into_bytes());
                    }
                    if typing {
                        self.set_driver(id, self.me);
                    }
                } else if self.terminals.get(&id).is_some_and(|t| t.writable) {
                    self.to_host(&AppMsg::TermInput { id, data: Bytes(data.into_bytes()) });
                }
            }
            CtlIn::TermResize { id, cols, rows } => {
                if self.is_host() {
                    self.set_view(id, self.me, cols, rows);
                } else if let Some(t) = self.terminals.get_mut(&id) {
                    t.mine = (cols > 0 && rows > 0).then_some((cols, rows));
                    self.to_host(&AppMsg::TermResize { id, cols, rows });
                }
            }
            CtlIn::TermFit { id } => {
                if self.is_host() {
                    self.set_driver(id, self.me);
                } else if self.terminals.contains_key(&id) {
                    self.to_host(&AppMsg::TermFit { id });
                }
            }
            CtlIn::TermClose { id } => {
                if let Some(pty) = self.terminals.get_mut(&id).and_then(|t| t.pty.as_mut()) {
                    pty.kill(); // TermExited follows
                }
            }
            CtlIn::Presence { path, data } => self.send(None, &AppMsg::Presence { path, data }),
            CtlIn::Save { path } => {
                if !self.is_host() {
                    self.to_host(&AppMsg::Save { path });
                }
            }
            CtlIn::LangRequest { id, method, args } => {
                if !self.is_host() {
                    self.to_host(&AppMsg::LangRequest { id, method, args });
                }
            }
            CtlIn::LangResponse { to, id, ok, err } => {
                let result = match (ok, err) {
                    (Some(ok), _) => Ok(ok),
                    (None, e) => Err(e.unwrap_or_else(|| "no result".into())),
                };
                self.send(Some(to), &AppMsg::LangResponse { id, result });
            }
            CtlIn::Diagnostics { path, json } => {
                if self.is_host() {
                    self.send(None, &AppMsg::Diagnostics { path, json });
                }
            }
        }
        Flow::Continue
    }

    fn emit_fs_result(&self, id: u64, r: Result<FsReply, String>) {
        let (ok, err) = match r {
            Ok(FsReply::Dir(d)) => (Some(FsOut::Dir(d)), None),
            Ok(FsReply::Stat(s)) => (Some(FsOut::Stat(s)), None),
            Ok(FsReply::Data(b)) => (Some(FsOut::Data(B64(b))), None),
            Ok(FsReply::Done) => (Some(FsOut::Done), None),
            Err(e) => (None, Some(e)),
        };
        self.emit(CtlOut::FsResult { id, ok, err });
    }

    // --------------------------------------------------------------- host

    fn fs_op(&self, op: &FsOp) -> Result<FsReply, String> {
        let ws = self.workspace.as_ref().ok_or("not hosting")?;
        match op {
            FsOp::ReadDir(p) => ws.read_dir(p).map(FsReply::Dir),
            FsOp::Stat(p) => ws.stat(p).map(FsReply::Stat),
            FsOp::Read(p) => ws.read(p).map(FsReply::Data),
            _ => Err("not a read".into()),
        }
    }

    /// A guest wants to change files: check it against the sandbox, then let
    /// the host's editor do it (open editors and unsaved buffers follow a
    /// rename that way, and deletes go to the host's trash).
    fn start_mutation(&mut self, from: PeerId, id: u64, op: FsOp) {
        let Some(ws) = &self.workspace else { return };
        if let Err(e) = ws.check_mutation(&op) {
            self.send(Some(from), &AppMsg::FsResult { id, result: Err(e) });
            return;
        }
        if self.ctl.is_none() {
            let e = "Unavailable: the host's editor isn't connected right now; try again in a moment".to_string();
            self.send(Some(from), &AppMsg::FsResult { id, result: Err(e) });
            return;
        }
        let creates = matches!(&op, FsOp::Write { path, .. } if ws.resolve(path).is_err());
        let local = self.next_fs;
        self.next_fs += 1;
        info!(from, ?op, "guest file change");
        self.emit(CtlOut::FsApply { id: local, op: op.clone() });
        self.pending_fs.insert(local, PendingFs { from, id, op, creates });
    }

    /// Files appeared, changed or went away: drop shared documents that no
    /// longer exist and tell everyone, so explorers update right away.
    fn fs_changed(&mut self, c: FsChanges) {
        if c.created.is_empty() && c.changed.is_empty() && c.removed.is_empty() && c.renamed.is_empty() {
            return;
        }
        let moved = self.rename_docs(&c.renamed);
        self.drop_docs_under(&c.removed);
        self.emit(CtlOut::FsChanged {
            created: c.created.clone(),
            changed: c.changed.clone(),
            removed: c.removed.clone(),
            renamed: c.renamed.clone(),
        });
        // After FsChanged, so the extension has dropped the old bindings.
        for path in moved {
            if let Ok(state) = self.store.full_state(&path) {
                self.emit(CtlOut::DocState { path, update: B64(state) });
            }
        }
        if self.is_host() {
            // Peers from before `renamed` see a rename as a delete and a create.
            let (mut created, mut removed) = (c.created, c.removed);
            for (from, to) in &c.renamed {
                removed.push(from.clone());
                created.push(to.clone());
            }
            self.send(None, &AppMsg::FsChanged { created, changed: c.changed, removed, renamed: c.renamed });
        }
    }

    /// Shared documents below a renamed path keep their content, history and
    /// collaborators under the new name. Returns the new paths.
    fn rename_docs(&mut self, renamed: &[(String, String)]) -> Vec<String> {
        let mut out = Vec::new();
        for (from, to) in renamed {
            let docs: Vec<(String, String)> =
                self.store.paths().filter_map(|p| moved(p, from, to).map(|n| (p.to_string(), n))).collect();
            for (old, new) in docs {
                debug!(old, new, "shared document renamed");
                self.store.rename(&old, &new);
                out.push(new);
            }
            self.requested = std::mem::take(&mut self.requested)
                .into_iter()
                .map(|p| moved(&p, from, to).unwrap_or(p))
                .collect();
        }
        out
    }

    fn drop_docs_under(&mut self, removed: &[String]) {
        let gone: Vec<String> =
            self.store.paths().filter(|p| removed.iter().any(|r| is_under(p, r))).map(String::from).collect();
        for path in gone {
            debug!(path, "shared document removed");
            self.store.close(&path);
        }
        self.requested.retain(|p| !removed.iter().any(|r| is_under(p, r)));
    }

    // ---------------------------------------------------------- terminals

    fn open_terminal(&mut self, name: String, shell: Option<String>, writable: bool) {
        let Some(ws) = &self.workspace else { return };
        let id = self.next_term;
        match Pty::spawn(shell.as_deref(), ws.root(), id, self.events.clone()) {
            Ok(pty) => {
                self.next_term += 1;
                info!(id, name, writable, "terminal shared");
                self.terminals.insert(id, Terminal::new(name.clone(), writable, Some(pty), self.me));
                self.emit(CtlOut::TermOpened { id, name: name.clone(), writable });
                self.send(None, &AppMsg::TermOpened { id, name, writable });
            }
            Err(e) => self.emit(CtlOut::Error { message: format!("could not start a terminal: {e}") }),
        }
    }

    fn on_term_output(&mut self, id: u32, data: Vec<u8>) {
        let Some(t) = self.terminals.get_mut(&id) else { return };
        term::push_scrollback(&mut t.scrollback, &data);
        self.emit(CtlOut::TermOutput { id, data: B64(data.clone()) });
        if self.is_host() {
            self.send(None, &AppMsg::TermOutput { id, data: Bytes(data) });
        }
    }

    fn close_terminal(&mut self, id: u32, code: Option<u32>) {
        if self.terminals.remove(&id).is_none() {
            return;
        }
        self.emit(CtlOut::TermClosed { id, code });
        if self.is_host() {
            info!(id, ?code, "terminal closed");
            self.send(None, &AppMsg::TermClosed { id, code });
        }
    }

    /// Host: someone's tab for terminal `id` changed size (0×0: they closed
    /// it, or left).
    fn set_view(&mut self, id: u32, peer: PeerId, cols: u16, rows: u16) {
        let host = self.me;
        let Some(t) = self.terminals.get_mut(&id) else { return };
        if cols == 0 || rows == 0 {
            t.views.remove(&peer);
            if t.driver == peer {
                t.driver = host;
            }
        } else {
            t.views.insert(peer, (cols, rows));
        }
        self.apply_size(id);
    }

    /// Host: size terminal `id` to fit `peer`'s tab from now on.
    fn set_driver(&mut self, id: u32, peer: PeerId) {
        let Some(t) = self.terminals.get_mut(&id) else { return };
        if t.driver != peer {
            t.driver = peer;
            self.apply_size(id);
        }
    }

    fn apply_size(&mut self, id: u32) {
        let host = self.me;
        let Some(t) = self.terminals.get_mut(&id) else { return };
        let by = if t.views.contains_key(&t.driver) { t.driver } else { host };
        // Nobody to fit (the host's tab isn't open yet): keep the last size.
        let Some(&(cols, rows)) = t.views.get(&by) else { return };
        let size = (cols.max(MIN_COLS), rows.max(MIN_ROWS));
        if (size, by) == (t.size, t.by) {
            return;
        }
        if size != t.size
            && let Some(pty) = &t.pty
        {
            pty.resize(size.0, size.1);
        }
        t.size = size;
        t.by = by;
        debug!(id, cols = size.0, rows = size.1, by, "terminal resized");
        self.emit(CtlOut::TermSize { id, cols: size.0, rows: size.1, by });
        self.send(None, &AppMsg::TermSize { id, cols: size.0, rows: size.1, by });
    }

    /// Host: bring a newly joined guest up to date with the open terminals.
    fn replay_terminals(&self, to: PeerId) {
        for (&id, t) in &self.terminals {
            self.send(Some(to), &AppMsg::TermOpened { id, name: t.name.clone(), writable: t.writable });
            self.send(Some(to), &AppMsg::TermSize { id, cols: t.size.0, rows: t.size.1, by: t.by });
            if !t.scrollback.is_empty() {
                self.send(Some(to), &AppMsg::TermOutput { id, data: Bytes(t.scrollback.clone()) });
            }
        }
    }

    /// Create the shared document for `path`. Prefer the host editor's
    /// buffer over the disk (it may hold unsaved changes).
    fn start_seed(&mut self, path: &str, waiter: Option<PeerId>) {
        if let Some(s) = self.seeding.get_mut(path) {
            s.waiters.extend(waiter);
            return;
        }
        let Some(ws) = &self.workspace else { return };
        match ws.read_text(path) {
            Err(error) => self.open_failed(path, waiter, error),
            Ok(None) => self.open_failed(path, waiter, "binary".into()),
            Ok(Some(_)) => {
                self.seeding.insert(
                    path.into(),
                    Seeding { started: Instant::now(), waiters: waiter.into_iter().collect() },
                );
                if self.ctl.is_some() {
                    self.emit(CtlOut::ReadDoc { path: path.into() });
                } else {
                    self.finish_seed(path, None);
                }
            }
        }
    }

    fn open_failed(&self, path: &str, waiter: Option<PeerId>, error: String) {
        let m = AppMsg::OpenFailed { path: path.into(), error: error.clone() };
        match waiter {
            Some(peer) => self.send(Some(peer), &m),
            None => self.emit(CtlOut::OpenFailed { path: path.into(), error }),
        }
    }

    fn finish_seed(&mut self, path: &str, text: Option<String>) {
        let Some(seeding) = self.seeding.remove(path) else { return };
        let text = match text {
            Some(t) => t,
            None => match self.workspace.as_ref().map(|w| w.read_text(path)) {
                Some(Ok(Some(t))) => t,
                other => {
                    let error = match other {
                        Some(Err(e)) => e,
                        _ => "binary".into(),
                    };
                    for w in seeding.waiters {
                        self.open_failed(path, Some(w), error.clone());
                    }
                    return;
                }
            },
        };
        let state = match self.store.create(path, &text) {
            Ok(s) => s,
            Err(e) => {
                warn!("seeding {path}: {e}");
                return;
            }
        };
        info!(path, "document shared");
        self.emit(CtlOut::DocState { path: path.into(), update: B64(state.clone()) });
        for w in seeding.waiters {
            self.send(Some(w), &AppMsg::DocState { path: path.into(), update: state.clone() });
        }
    }

    // -------------------------------------------------------------- relay

    fn on_relay(&mut self, e: RelayEvent) -> Flow {
        let msg = match e {
            RelayEvent::Lost(reason) => {
                if self.is_host() {
                    self.emit(CtlOut::Ended { reason: format!("lost connection to relay: {reason}") });
                    return Flow::Exit;
                }
                self.connected = false;
                self.emit(CtlOut::Status { connected: false });
                return Flow::Continue;
            }
            RelayEvent::Msg(m) => m,
        };
        match msg {
            RelayMsg::Envelope { from, payload } => match decode::<AppMsg>(&payload) {
                Ok(app) => self.on_app(from, app),
                Err(e) => warn!(from, "undecodable message: {e}"),
            },
            RelayMsg::PeerJoined(p) => {
                info!(peer = p.id, name = %p.name, "peer joined");
                self.peers.insert(p.id, p.clone());
                if self.is_host() {
                    self.replay_terminals(p.id);
                }
                self.emit(CtlOut::PeerJoined { peer: p });
            }
            RelayMsg::PeerLeft(id) => {
                self.peers.remove(&id);
                if self.is_host() {
                    let terms: Vec<u32> = self.terminals.keys().copied().collect();
                    for t in terms {
                        self.set_view(t, id, 0, 0);
                    }
                }
                self.emit(CtlOut::PeerLeft { id });
            }
            RelayMsg::SessionEnded => {
                self.emit(CtlOut::Ended { reason: "the host ended the session".into() });
                return Flow::Exit;
            }
            RelayMsg::Joined { you, peers } => {
                // Guest reconnected: new identity, then repair everything.
                self.me = you;
                self.peers = peers.into_iter().map(|p| (p.id, p)).collect();
                self.connected = true;
                self.emit(CtlOut::Peers { me: you, peers: self.peers.values().cloned().collect() });
                self.emit(CtlOut::Status { connected: true });
                for path in self.requested.clone() {
                    self.to_host(&AppMsg::OpenDoc { path });
                }
                self.anti_entropy();
            }
            RelayMsg::Error(message) => self.emit(CtlOut::Error { message }),
            RelayMsg::Pong => {}
            other => debug!("ignoring {other:?}"),
        }
        Flow::Continue
    }

    fn on_app(&mut self, from: PeerId, msg: AppMsg) {
        let host = self.is_host();
        // Only the host may answer as the host.
        let from_host = self.peers.get(&from).is_some_and(|p| p.role == Role::Host);
        match msg {
            AppMsg::Fs { id, op } if host && op.is_mutation() => self.start_mutation(from, id, op),
            AppMsg::Fs { id, op } if host => {
                let r = self.fs_op(&op);
                self.send(Some(from), &AppMsg::FsResult { id, result: r });
            }
            AppMsg::FsResult { id, result } if from_host => self.emit_fs_result(id, result),
            AppMsg::OpenDoc { path } if host => {
                if self.store.is_open(&path) {
                    if let Ok(update) = self.store.full_state(&path) {
                        self.send(Some(from), &AppMsg::DocState { path, update });
                    }
                } else {
                    self.start_seed(&path, Some(from));
                }
            }
            AppMsg::DocState { path, update } if from_host => {
                let was_requested = self.requested.remove(&path);
                let was_open = self.store.is_open(&path);
                if !was_requested && !was_open {
                    return; // closed in the meantime
                }
                match self.store.load(&path, &update) {
                    Ok(_) if was_open => self.emit(CtlOut::Update { path, update: B64(update) }),
                    Ok(_) => {
                        if let Ok(state) = self.store.full_state(&path) {
                            self.emit(CtlOut::DocState { path, update: B64(state) });
                        }
                    }
                    Err(e) => warn!("bad document state for {path}: {e}"),
                }
            }
            AppMsg::OpenFailed { path, error } if from_host => {
                self.requested.remove(&path);
                self.emit(CtlOut::OpenFailed { path, error });
            }
            AppMsg::DocUpdate { path, update } => {
                if !self.store.is_open(&path) {
                    return;
                }
                match self.store.apply_remote(&path, &update) {
                    Ok(_) => self.emit(CtlOut::Update { path, update: B64(update) }),
                    Err(e) => warn!(from, "rejected update for {path}: {e}"),
                }
            }
            AppMsg::SyncStep1 { path, state_vector, want_reply } => {
                if !self.store.is_open(&path) {
                    return;
                }
                if let Ok(diff) = self.store.diff_since(&path, &state_vector)
                    && !is_empty_update(&diff)
                {
                    debug!(from, path, "anti-entropy repair ({} bytes)", diff.len());
                    self.send(Some(from), &AppMsg::DocUpdate { path: path.clone(), update: diff });
                }
                if want_reply && let Ok(sv) = self.store.state_vector(&path) {
                    self.send(Some(from), &AppMsg::SyncStep1 { path, state_vector: sv, want_reply: false });
                }
            }
            AppMsg::Presence { path, data } => self.emit(CtlOut::Presence { from, path, data }),
            AppMsg::Save { path } if host => self.emit(CtlOut::Save { path }),
            AppMsg::LangRequest { id, method, args } if host => {
                self.emit(CtlOut::LangRequest { from, id, method, args })
            }
            AppMsg::LangResponse { id, result } if from_host => {
                let (ok, err) = match result {
                    Ok(o) => (Some(o), None),
                    Err(e) => (None, Some(e)),
                };
                self.emit(CtlOut::LangResponse { id, ok, err });
            }
            AppMsg::Diagnostics { path, json } if from_host => self.emit(CtlOut::Diagnostics { path, json }),
            AppMsg::FsChanged { mut created, changed, mut removed, renamed } if from_host => {
                // Renames are also listed as removed + created (for older peers).
                removed.retain(|p| !renamed.iter().any(|(from, _)| from == p));
                created.retain(|p| !renamed.iter().any(|(_, to)| to == p));
                self.fs_changed(FsChanges { created, changed, removed, renamed })
            }
            AppMsg::TermOpened { id, name, writable } if from_host => {
                // Also sent again after a reconnect: start over with the
                // replay, and tell the host my tab's size again.
                let mine = self.terminals.get(&id).and_then(|t| t.mine);
                let mut t = Terminal::new(name.clone(), writable, None, from);
                t.mine = mine;
                self.terminals.insert(id, t);
                self.emit(CtlOut::TermOpened { id, name, writable });
                if let Some((cols, rows)) = mine {
                    self.to_host(&AppMsg::TermResize { id, cols, rows });
                }
            }
            AppMsg::TermResize { id, cols, rows } if host => {
                if self.peers.contains_key(&from) {
                    self.set_view(id, from, cols, rows);
                }
            }
            AppMsg::TermFit { id } if host => {
                if self.peers.contains_key(&from) {
                    self.set_driver(id, from);
                }
            }
            AppMsg::TermSize { id, cols, rows, by } if from_host => {
                if let Some(t) = self.terminals.get_mut(&id) {
                    t.size = (cols, rows);
                    t.by = by;
                    self.emit(CtlOut::TermSize { id, cols, rows, by });
                }
            }
            AppMsg::TermOutput { id, data } if from_host => self.on_term_output(id, data.0),
            AppMsg::TermClosed { id, code } if from_host => self.close_terminal(id, code),
            AppMsg::TermInput { id, data } if host => match self.terminals.get(&id) {
                Some(Terminal { writable: true, pty: Some(pty), .. }) => {
                    let typing = is_typing(&data.0);
                    pty.write(data.0);
                    if typing && self.peers.contains_key(&from) {
                        self.set_driver(id, from);
                    }
                }
                Some(_) => warn!(from, id, "dropping input for a read-only terminal"),
                None => {}
            },
            other => warn!(from, "ignoring unexpected message {other:?}"),
        }
    }

    // --------------------------------------------------------------- timer

    fn anti_entropy(&self) {
        if self.is_host() || !self.connected {
            return;
        }
        for path in self.store.paths() {
            if let Ok(sv) = self.store.state_vector(path) {
                self.to_host(&AppMsg::SyncStep1 { path: path.into(), state_vector: sv, want_reply: true });
            }
        }
    }

    fn on_tick(&mut self) -> Flow {
        self.anti_entropy();
        let stale: Vec<String> = self
            .seeding
            .iter()
            .filter(|(_, s)| s.started.elapsed() > SEED_TIMEOUT)
            .map(|(p, _)| p.clone())
            .collect();
        for path in stale {
            warn!(path, "editor did not provide buffer; seeding from disk");
            self.finish_seed(&path, None);
        }
        if self.ctl_lost_at.is_some_and(|t| t.elapsed() > ORPHAN_TIMEOUT) {
            warn!("no editor attached for {ORPHAN_TIMEOUT:?}; leaving session");
            return Flow::Exit;
        }
        Flow::Continue
    }
}

#[cfg(test)]
mod tests {
    use super::is_typing;

    #[test]
    fn widget_replies_are_not_typing() {
        assert!(!is_typing(b""));
        assert!(!is_typing(b"\x1b[12;40R"));
        assert!(!is_typing(b"\x1b[I\x1b[3;1R\x1b[O"));
        assert!(is_typing(b"ls\r"));
        assert!(is_typing(b"\x1b[A")); // arrow up
        assert!(is_typing(b"\x1b[3;1Rx"));
        assert!(is_typing(b"\x1b"));
    }
}
