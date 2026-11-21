//! Shared terminals: a real shell on the host, in a pseudo-terminal, whose
//! output is streamed to everyone. Only the host starts terminals; guests may
//! type into one only if the host made it writable.
//!
//! The pty API is blocking, so reading, writing and waiting for exit each get
//! a small thread that feeds the daemon's event loop.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc as std_mpsc;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::mpsc;
use tracing::warn;

use crate::Event;

/// Output kept per terminal, replayed to guests who join (or reload) later.
pub const SCROLLBACK: usize = 256 * 1024;

pub struct Pty {
    master: Box<dyn MasterPty + Send>,
    input: std_mpsc::Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl Pty {
    /// Start `shell` (or the platform default) in `cwd`.
    pub fn spawn(shell: Option<&str>, cwd: &Path, id: u32, events: mpsc::UnboundedSender<Event>) -> anyhow::Result<Self> {
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })?;
        let shell = shell.filter(|s| !s.trim().is_empty()).map(String::from).unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| anyhow::anyhow!("could not start {shell}: {e}"))?;
        drop(pair.slave);
        let killer = child.clone_killer();

        let mut reader = pair.master.try_clone_reader()?;
        let out = events.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if out.send(Event::TermOutput(id, buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let mut writer = pair.master.take_writer()?;
        let (input, rx) = std_mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            for data in rx {
                if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                    break;
                }
            }
        });

        std::thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code());
            let _ = events.send(Event::TermExited(id, code));
        });

        Ok(Self { master: pair.master, input, killer })
    }

    pub fn write(&self, data: Vec<u8>) {
        let _ = self.input.send(data);
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let size = PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 };
        if let Err(e) = self.master.resize(size) {
            warn!("resizing terminal: {e}");
        }
    }

    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        self.kill();
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

/// Append output, keeping at most [`SCROLLBACK`] bytes. When trimming, start
/// at a line boundary so the replay doesn't begin mid escape sequence.
pub fn push_scrollback(buf: &mut Vec<u8>, data: &[u8]) {
    buf.extend_from_slice(data);
    if buf.len() > SCROLLBACK {
        let mut cut = buf.len() - SCROLLBACK;
        if let Some(nl) = buf[cut..].iter().take(4096).position(|&b| b == b'\n') {
            cut += nl + 1;
        }
        buf.drain(..cut);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrollback_is_capped_at_a_line_boundary() {
        let mut buf = Vec::new();
        let line = b"0123456789abcdef\n";
        for _ in 0..(SCROLLBACK / line.len() + 100) {
            push_scrollback(&mut buf, line);
        }
        assert!(buf.len() <= SCROLLBACK);
        assert!(buf.starts_with(b"0123"), "replay should start at a fresh line");
    }
}
