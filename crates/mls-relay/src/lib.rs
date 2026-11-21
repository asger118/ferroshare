//! Self-hostable relay. Routes opaque frames between the peers of a session.
//!
//! The relay never inspects document payloads, so it cannot corrupt state and
//! end-to-end encryption can be added without changing it. It speaks plain
//! WebSocket, which works through almost any firewall/NAT (put it behind a TLS
//! reverse proxy on :443 for the most hostile networks).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use futures_util::{SinkExt, StreamExt};
use mls_proto::{PROTOCOL_VERSION, PeerId, PeerInfo, RelayMsg, Role, decode, encode};
use sha2::{Digest, Sha256};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, mpsc};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tracing::{info, warn};

/// Largest frame accepted (a big file's initial state still fits).
pub const MAX_FRAME: usize = 64 * 1024 * 1024;

type Tx = mpsc::UnboundedSender<Message>;

struct Peer {
    info: PeerInfo,
    tx: Tx,
}

struct Session {
    token_hash: [u8; 32],
    peers: HashMap<PeerId, Peer>,
}

#[derive(Default)]
struct State {
    sessions: HashMap<String, Session>,
}

#[derive(Clone, Default)]
pub struct Relay {
    state: Arc<Mutex<State>>,
    next_id: Arc<AtomicU32>,
}

fn hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn random_hex(bytes: usize) -> String {
    let buf: Vec<u8> = (0..bytes).map(|_| rand::random::<u8>()).collect();
    hex::encode(buf)
}

fn frame(msg: &RelayMsg) -> Message {
    Message::Binary(encode(msg).expect("relay messages always encode").into())
}

impl Relay {
    pub fn new() -> Self {
        Self {
            next_id: Arc::new(AtomicU32::new(1)),
            ..Default::default()
        }
    }

    /// Accept connections forever.
    pub async fn serve(self, listener: TcpListener) -> std::io::Result<()> {
        loop {
            let (stream, addr) = listener.accept().await?;
            let relay = self.clone();
            tokio::spawn(async move {
                if let Err(e) = relay.handle(stream).await {
                    warn!(%addr, "connection ended: {e:#}");
                }
            });
        }
    }

    async fn handle(&self, stream: TcpStream) -> anyhow::Result<()> {
        stream.set_nodelay(true)?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_FRAME))
            .max_frame_size(Some(MAX_FRAME));
        let ws = tokio_tungstenite::accept_async_with_config(stream, Some(config)).await?;
        let (mut sink, mut source) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

        // Writer task: everything destined for this peer goes through `tx`.
        let writer = tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                if sink.send(m).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        // First frame must create or join a session.
        let joined = match next_msg(&mut source).await? {
            Some(RelayMsg::CreateSession { version, name }) => {
                check_version(version, &tx)?;
                self.create(name, tx.clone()).await
            }
            Some(RelayMsg::JoinSession { version, session, token, name }) => {
                check_version(version, &tx)?;
                match self.join(&session, &token, name, tx.clone()).await {
                    Ok(j) => j,
                    Err(e) => {
                        let _ = tx.send(frame(&RelayMsg::Error(e.clone())));
                        drop(tx);
                        let _ = writer.await;
                        anyhow::bail!(e);
                    }
                }
            }
            Some(_) => anyhow::bail!("expected CreateSession or JoinSession"),
            None => return Ok(()),
        };
        let (session, me, role) = joined;

        let result = async {
            while let Some(msg) = next_msg(&mut source).await? {
                match msg {
                    RelayMsg::Send { to, payload } => self.route(&session, me, to, payload).await,
                    RelayMsg::Ping => {
                        let _ = tx.send(frame(&RelayMsg::Pong));
                    }
                    other => warn!(peer = me, "unexpected frame {other:?}"),
                }
            }
            anyhow::Ok(())
        }
        .await;

        self.leave(&session, me, role).await;
        drop(tx);
        let _ = writer.await;
        result
    }

    async fn create(&self, name: String, tx: Tx) -> (String, PeerId, Role) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let session = random_hex(8);
        let token = random_hex(16);
        let info = PeerInfo { id, name, role: Role::Host };
        let _ = tx.send(frame(&RelayMsg::SessionCreated {
            session: session.clone(),
            token: token.clone(),
            you: id,
        }));
        let mut st = self.state.lock().await;
        st.sessions.insert(
            session.clone(),
            Session {
                token_hash: hash(&token),
                peers: HashMap::from([(id, Peer { info, tx })]),
            },
        );
        info!(%session, "session created");
        (session, id, Role::Host)
    }

    async fn join(
        &self,
        session: &str,
        token: &str,
        name: String,
        tx: Tx,
    ) -> Result<(String, PeerId, Role), String> {
        let mut st = self.state.lock().await;
        let s = st
            .sessions
            .get_mut(session)
            .ok_or("session not found — has the host ended it?")?;
        // Compare hashes so timing doesn't leak the token prefix.
        if s.token_hash != hash(token) {
            return Err("invalid invite token".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let info = PeerInfo { id, name, role: Role::Guest };
        let peers = s.peers.values().map(|p| p.info.clone()).collect();
        let _ = tx.send(frame(&RelayMsg::Joined { you: id, peers }));
        let announce = frame(&RelayMsg::PeerJoined(info.clone()));
        for p in s.peers.values() {
            let _ = p.tx.send(announce.clone());
        }
        s.peers.insert(id, Peer { info, tx });
        info!(%session, peer = id, "peer joined");
        Ok((session.to_string(), id, Role::Guest))
    }

    async fn route(&self, session: &str, from: PeerId, to: Option<PeerId>, payload: Vec<u8>) {
        let st = self.state.lock().await;
        let Some(s) = st.sessions.get(session) else { return };
        let msg = frame(&RelayMsg::Envelope { from, payload });
        match to {
            Some(id) => {
                if let Some(p) = s.peers.get(&id) {
                    let _ = p.tx.send(msg);
                }
            }
            None => {
                for (id, p) in &s.peers {
                    if *id != from {
                        let _ = p.tx.send(msg.clone());
                    }
                }
            }
        }
    }

    async fn leave(&self, session: &str, me: PeerId, role: Role) {
        let mut st = self.state.lock().await;
        if role == Role::Host {
            if let Some(s) = st.sessions.remove(session) {
                let end = frame(&RelayMsg::SessionEnded);
                for (id, p) in s.peers {
                    if id != me {
                        let _ = p.tx.send(end.clone());
                    }
                }
                info!(%session, "session ended (host left)");
            }
        } else if let Some(s) = st.sessions.get_mut(session) {
            s.peers.remove(&me);
            let left = frame(&RelayMsg::PeerLeft(me));
            for p in s.peers.values() {
                let _ = p.tx.send(left.clone());
            }
        }
    }
}

fn check_version(version: u32, tx: &Tx) -> anyhow::Result<()> {
    if version != PROTOCOL_VERSION {
        let e = format!(
            "protocol version mismatch: you have {version}, relay has {PROTOCOL_VERSION}. Update the extension."
        );
        let _ = tx.send(frame(&RelayMsg::Error(e.clone())));
        anyhow::bail!(e);
    }
    Ok(())
}

async fn next_msg<S>(source: &mut S) -> anyhow::Result<Option<RelayMsg>>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    while let Some(m) = source.next().await {
        match m? {
            Message::Binary(b) => return Ok(Some(decode(&b)?)),
            Message::Close(_) => return Ok(None),
            _ => continue, // ws-level ping/pong handled by tungstenite
        }
    }
    Ok(None)
}
