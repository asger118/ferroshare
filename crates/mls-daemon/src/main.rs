use std::io::Write;
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use mls::{Mode, run};

/// Ferroshare daemon. Normally started by the VS Code extension.
#[derive(Parser)]
#[command(version)]
struct Args {
    /// Display name shown to other participants.
    #[arg(long, global = true, default_value = "anonymous")]
    name: String,
    /// Write logs to this file instead of stderr.
    #[arg(long, global = true)]
    log: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Share a folder.
    Host {
        /// Relay URL, e.g. ws://my-server:7777
        #[arg(long)]
        relay: String,
        /// Folder to share.
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Join a session from an invite link.
    Join { invite: String },
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    match &args.log {
        Some(path) => {
            let file = std::fs::OpenOptions::new().create(true).append(true).open(path).expect("open log file");
            tracing_subscriber::fmt().with_env_filter(filter).with_ansi(false).with_writer(std::sync::Mutex::new(file)).init();
        }
        None => tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).init(),
    }

    let mode = match args.cmd {
        Cmd::Host { relay, root } => Mode::Host { relay, root },
        Cmd::Join { invite } => Mode::Join { invite },
    };
    // The extension reads exactly one JSON line from stdout: ready or error.
    let result = run(mode, args.name, |ready| {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{}", serde_json::to_string(ready).unwrap());
        let _ = out.flush();
    })
    .await;
    if let Err(e) = result {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{}", serde_json::json!({ "error": format!("{e:#}") }));
        let _ = out.flush();
        std::process::exit(1);
    }
}
