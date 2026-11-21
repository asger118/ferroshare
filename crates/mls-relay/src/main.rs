use clap::Parser;
use tokio::net::TcpListener;

/// Ferroshare relay. Run this somewhere all participants can reach.
#[derive(Parser)]
#[command(version)]
struct Args {
    /// Address to listen on.
    #[arg(long, default_value = "0.0.0.0:7777", env = "MLS_LISTEN")]
    listen: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        // No colour codes in `docker logs`, journald or redirected output.
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stdout()))
        .init();
    let args = Args::parse();
    let listener = TcpListener::bind(&args.listen).await?;
    tracing::info!("relay listening on ws://{}", listener.local_addr()?);
    tokio::select! {
        r = mls_relay::Relay::new().serve(listener) => r?,
        _ = shutdown_signal() => tracing::info!("shutting down"),
    }
    Ok(())
}

/// Ctrl+C, or SIGTERM from `docker stop` / systemd. As PID 1 in a container
/// the process gets no default SIGTERM handler, so it must handle it itself.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}
