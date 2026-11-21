//! `mls` — the per-user daemon. Connects to the relay, holds CRDT replicas,
//! serves the host's workspace to guests, and talks to the VS Code extension
//! over a localhost control socket.

pub mod crypto;
pub mod ctl;
pub mod daemon;
pub mod fs;
pub mod relay;
pub mod term;

use std::path::PathBuf;

use mls_proto::Role;
use serde::Serialize;
use tokio::net::TcpListener;
use tokio::sync::mpsc;

pub enum Event {
    Relay(relay::RelayEvent),
    CtlConnected(u64, mpsc::UnboundedSender<String>),
    CtlDisconnected(u64),
    Ctl(u64, ctl::CtlIn),
    /// A shared terminal produced output (host).
    TermOutput(u32, Vec<u8>),
    /// A shared terminal's process exited (host).
    TermExited(u32, Option<u32>),
}

pub enum Mode {
    Host { relay: String, root: PathBuf },
    Join { invite: String },
}

/// First line printed on stdout, so the extension can attach.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    pub port: u16,
    pub token: String,
    pub session: String,
    pub invite: String,
}

/// Connect to the relay, open the control socket, report `Ready`, then run
/// until the session ends.
pub async fn run(mode: Mode, name: String, ready: impl FnOnce(&Ready)) -> anyhow::Result<()> {
    let (ev_tx, ev_rx) = mpsc::unbounded_channel();
    let config = match mode {
        Mode::Host { relay, root } => {
            let workspace = fs::Workspace::new(&root)
                .map_err(|e| anyhow::anyhow!("cannot share {}: {e}", root.display()))?;
            let h = relay::start_host(&relay, &name, ev_tx.clone()).await?;
            daemon::Config {
                role: Role::Host,
                me: h.me,
                session: h.invite.session.clone(),
                invite: h.invite.format(),
                peers: vec![mls_proto::PeerInfo { id: h.me, name, role: Role::Host }],
                relay: h.tx,
                workspace: Some(workspace),
                events: ev_tx.clone(),
            }
        }
        Mode::Join { invite } => {
            let inv = relay::Invite::parse(&invite)?;
            let (session, invite) = (inv.session.clone(), inv.format());
            let g = relay::start_guest(inv, name, ev_tx.clone()).await?;
            daemon::Config {
                role: Role::Guest,
                me: g.me,
                session,
                invite,
                peers: g.peers,
                relay: g.tx,
                workspace: None,
                events: ev_tx.clone(),
            }
        }
    };

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let token = hex::encode((0..16).map(|_| rand::random::<u8>()).collect::<Vec<_>>());
    ready(&Ready {
        port: listener.local_addr()?.port(),
        token: token.clone(),
        session: config.session.clone(),
        invite: config.invite.clone(),
    });
    tokio::spawn(ctl::accept_loop(listener, token, ev_tx));
    daemon::Daemon::new(config).run(ev_rx).await;
    Ok(())
}
