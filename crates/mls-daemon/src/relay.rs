//! Connection to the relay. Guests reconnect automatically with backoff; the
//! main loop then runs an anti-entropy round so nothing typed while offline
//! is lost.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use mls_proto::{PROTOCOL_VERSION, PeerId, PeerInfo, RelayMsg, decode, encode};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tracing::{info, warn};

use crate::Event;
use crate::crypto::{OpenError, Sealer, SessionKey};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const MAX_FRAME: usize = 64 * 1024 * 1024;
const PING_EVERY: Duration = Duration::from_secs(20);

pub enum RelayEvent {
    Msg(RelayMsg),
    /// Connection dropped (guests: reconnect in progress).
    Lost(String),
}

pub struct Invite {
    pub relay: String,
    pub session: String,
    pub token: String,
    /// End-to-end key. Lives only in the link's `#fragment`; never sent to the relay.
    pub key: SessionKey,
}

impl Invite {
    /// Invite links look like `wss://relay.example#<session>.<token>.<key>`.
    pub fn parse(s: &str) -> anyhow::Result<Self> {
        let s = s.trim();
        let (relay, rest) = s
            .rsplit_once('#')
            .ok_or_else(|| anyhow::anyhow!("invalid invite link (expected wss://host#session.token.key)"))?;
        if !(relay.starts_with("ws://") || relay.starts_with("wss://")) {
            anyhow::bail!("invite link must start with ws:// or wss://");
        }
        let parts: Vec<&str> = rest.split('.').collect();
        let (session, token, key) = match parts[..] {
            [session, token, key] => (session, token, key),
            [_, _] => anyhow::bail!(
                "this invite link has no encryption key, so it is from an older version of Ferroshare; ask the host to update and share a new link"
            ),
            _ => anyhow::bail!("invalid invite link (expected wss://host#session.token.key)"),
        };
        Ok(Self {
            relay: relay.into(),
            session: session.into(),
            token: token.into(),
            key: SessionKey::parse(key)?,
        })
    }

    pub fn format(&self) -> String {
        format!("{}#{}.{}.{}", self.relay, self.session, self.token, self.key.encode())
    }
}

async fn connect(url: &str) -> anyhow::Result<Ws> {
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME))
        .max_frame_size(Some(MAX_FRAME));
    let connect = tokio_tungstenite::connect_async_with_config(url, Some(config), true);
    let (ws, _) = tokio::time::timeout(Duration::from_secs(10), connect)
        .await
        .map_err(|_| anyhow::anyhow!("timed out connecting to relay {url}"))?
        .map_err(|e| anyhow::anyhow!("could not reach relay {url}: {e}"))?;
    Ok(ws)
}

async fn send(ws: &mut Ws, m: &RelayMsg) -> anyhow::Result<()> {
    ws.send(Message::Binary(encode(m)?.into())).await?;
    Ok(())
}

async fn recv(ws: &mut Ws) -> anyhow::Result<RelayMsg> {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .map_err(|_| anyhow::anyhow!("relay did not answer"))?
            .ok_or_else(|| anyhow::anyhow!("relay closed the connection"))??;
        if let Message::Binary(b) = m {
            return Ok(decode(&b)?);
        }
    }
}

pub struct HostSession {
    pub invite: Invite,
    pub me: PeerId,
    pub tx: mpsc::UnboundedSender<RelayMsg>,
}

pub async fn start_host(url: &str, name: &str, events: mpsc::UnboundedSender<Event>) -> anyhow::Result<HostSession> {
    let mut ws = connect(url).await?;
    send(&mut ws, &RelayMsg::CreateSession { version: PROTOCOL_VERSION, name: name.into() }).await?;
    let (session, token, me) = match recv(&mut ws).await? {
        RelayMsg::SessionCreated { session, token, you } => (session, token, you),
        RelayMsg::Error(e) => anyhow::bail!("relay refused: {e}"),
        m => anyhow::bail!("unexpected reply from relay: {m:?}"),
    };
    let key = SessionKey::generate();
    let mut sealer = Sealer::new(&key, &session, me);
    let (tx, mut rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let reason = pump(ws, &mut rx, &events, &mut sealer).await;
        let _ = events.send(Event::Relay(RelayEvent::Lost(reason)));
    });
    Ok(HostSession {
        invite: Invite { relay: url.into(), session, token, key },
        me,
        tx,
    })
}

pub struct GuestSession {
    pub me: PeerId,
    pub peers: Vec<PeerInfo>,
    pub tx: mpsc::UnboundedSender<RelayMsg>,
}

async fn join(invite: &Invite, name: &str) -> anyhow::Result<(Ws, PeerId, Vec<PeerInfo>)> {
    let mut ws = connect(&invite.relay).await?;
    send(
        &mut ws,
        &RelayMsg::JoinSession {
            version: PROTOCOL_VERSION,
            session: invite.session.clone(),
            token: invite.token.clone(),
            name: name.into(),
        },
    )
    .await?;
    match recv(&mut ws).await? {
        RelayMsg::Joined { you, peers } => Ok((ws, you, peers)),
        RelayMsg::Error(e) => Err(JoinRefused(e).into()),
        m => anyhow::bail!("unexpected reply from relay: {m:?}"),
    }
}

#[derive(Debug)]
struct JoinRefused(String);
impl std::fmt::Display for JoinRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for JoinRefused {}

pub async fn start_guest(invite: Invite, name: String, events: mpsc::UnboundedSender<Event>) -> anyhow::Result<GuestSession> {
    let (mut ws, me, peers) = join(&invite, &name).await?;
    let mut sealer = Sealer::new(&invite.key, &invite.session, me);
    let (tx, mut rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let reason = pump(ws, &mut rx, &events, &mut sealer).await;
            if rx.is_closed() {
                return;
            }
            warn!("lost relay connection: {reason}; reconnecting");
            let _ = events.send(Event::Relay(RelayEvent::Lost(reason)));
            let mut delay = Duration::from_millis(500);
            ws = loop {
                tokio::time::sleep(delay).await;
                match join(&invite, &name).await {
                    Ok((ws, you, peers)) => {
                        info!("reconnected to relay");
                        sealer.me = you;
                        let _ = events.send(Event::Relay(RelayEvent::Msg(RelayMsg::Joined { you, peers })));
                        break ws;
                    }
                    Err(e) if e.is::<JoinRefused>() => {
                        // Session is gone (host left); no point retrying.
                        let _ = events.send(Event::Relay(RelayEvent::Msg(RelayMsg::SessionEnded)));
                        return;
                    }
                    Err(e) => {
                        warn!("reconnect failed: {e:#}");
                        delay = (delay * 2).min(Duration::from_secs(10));
                    }
                }
            };
        }
    });
    Ok(GuestSession { me, peers, tx })
}

/// Shuttle frames until the connection drops. Returns the reason. Peer
/// payloads are sealed on the way out and opened on the way in, so the rest
/// of the daemon only ever sees plaintext.
async fn pump(
    ws: Ws,
    out: &mut mpsc::UnboundedReceiver<RelayMsg>,
    events: &mpsc::UnboundedSender<Event>,
    sealer: &mut Sealer,
) -> String {
    let (mut sink, mut stream) = ws.split();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    loop {
        tokio::select! {
            m = stream.next() => match m {
                Some(Ok(Message::Binary(b))) => match decode::<RelayMsg>(&b) {
                    Ok(RelayMsg::Envelope { from, payload }) => match sealer.open(from, &payload) {
                        Ok(payload) => {
                            if events.send(Event::Relay(RelayEvent::Msg(RelayMsg::Envelope { from, payload }))).is_err() {
                                return "shutting down".into();
                            }
                        }
                        Err(OpenError::Forged) => warn!("dropped a message from peer {from} that failed decryption (wrong key or tampered)"),
                        Err(OpenError::Replay) => warn!("dropped a replayed message from peer {from}"),
                    },
                    Ok(msg) => {
                        if events.send(Event::Relay(RelayEvent::Msg(msg))).is_err() {
                            return "shutting down".into();
                        }
                    }
                    Err(e) => warn!("undecodable frame from relay: {e}"),
                },
                Some(Ok(Message::Close(_))) | None => return "relay closed the connection".into(),
                Some(Ok(_)) => {}
                Some(Err(e)) => return e.to_string(),
            },
            o = out.recv() => match o {
                Some(msg) => {
                    let msg = match msg {
                        RelayMsg::Send { to, payload } => RelayMsg::Send { to, payload: sealer.seal(&payload) },
                        other => other,
                    };
                    match encode(&msg) {
                        Ok(bytes) => {
                            if let Err(e) = sink.send(Message::Binary(bytes.into())).await {
                                return e.to_string();
                            }
                        }
                        Err(e) => warn!("could not encode frame: {e}"),
                    }
                }
                None => {
                    let _ = sink.close().await;
                    return "shutting down".into();
                }
            },
            _ = ping.tick() => {
                if let Ok(bytes) = encode(&RelayMsg::Ping)
                    && let Err(e) = sink.send(Message::Binary(bytes.into())).await
                {
                    return e.to_string();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_roundtrip() {
        let key = SessionKey::generate().encode();
        let link = format!("wss://relay.example.dk#abcd.ef01.{key}");
        let i = Invite::parse(&format!(" {link} ")).unwrap();
        assert_eq!((i.relay.as_str(), i.session.as_str(), i.token.as_str()), ("wss://relay.example.dk", "abcd", "ef01"));
        assert_eq!(i.key.encode(), key);
        assert_eq!(i.format(), link);
        assert!(Invite::parse(&format!("http://x#a.b.{key}")).is_err());
        assert!(Invite::parse("ws://x").is_err());
        assert!(Invite::parse("ws://x#a.b.notakey").is_err());
        let old = Invite::parse("ws://10.0.0.5:7777#abcd.ef01").err().unwrap().to_string();
        assert!(old.contains("older version"), "{old}");
    }
}
