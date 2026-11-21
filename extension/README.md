# Ferroshare

Real-time collaborative editing for VS Code, over a relay **you** run. No accounts, no Microsoft service, and everything is end-to-end encrypted.

## Features

- **Joining just works.** Send a friend an invite link. They paste it and a window opens with your project. No sign-in.
- **Guests get your IntelliSense.** Completion, hover, go-to-definition, references, rename, signature help, formatting, semantic highlighting, inlay hints and diagnostics are answered by *your* VS Code, using your extensions (clangd, C# Dev Kit, TypeScript, …). Guests don't need the toolchain installed.
- **Sync can't drift.** Every participant holds a CRDT replica, and lost updates are repaired automatically every few seconds.
- **Undo is per person.** Ctrl+Z undoes your own edits, never a friend's.
- **Guests can manage files.** Create, delete, rename and move files and folders from the explorer. Deletes go to the host's trash.
- **Renames keep your tabs.** When anyone renames or moves a file, everyone's open tabs follow it, unsaved changes included.
- **Shared terminals.** The host can share a terminal that guests watch (read-only) or type in (read/write). It's sized to fit everyone's panel.
- **End-to-end encrypted.** The key lives in the invite link's `#fragment` and never reaches the relay. The relay, and anything in front of it like Cloudflare, only sees ciphertext.
- **Self-hosted.** The relay is one small Rust binary or Docker image. It keeps no state and needs one port, or none if you use a Cloudflare Tunnel.

## Getting started

1. **Run a relay** somewhere your guests can reach: a VPS, your home PC with a forwarded port, or behind a Cloudflare Tunnel. See the [project repository](https://github.com/asger118/ferroshare#quick-start) for instructions. The quickest is Docker:

   ```sh
   docker run -d --restart unless-stopped -p 7777:7777 asgerveng/ferroshare-relay
   ```

2. **Point the extension at it:** set `ferroshare.relayUrl`, e.g. `wss://relay.example.com`.
3. **Host:** open the **Ferroshare** view in the Activity Bar, or click **Ferroshare** in the status bar, then choose **Host Session**. The invite link is copied to your clipboard.
4. **Join:** choose **Join Session** and paste the link.

Guests don't need a relay or any settings. The link says where to connect.

## Commands

| Command | |
|---|---|
| `Ferroshare: Host Session` | Share the current workspace folder and copy an invite link. |
| `Ferroshare: Join Session` | Join from an invite link. |
| `Ferroshare: Copy Invite Link` | Copy the invite again (host). |
| `Ferroshare: Share Terminal` | Host: start a shell others can watch, or type in. |
| `Ferroshare: Show Shared Terminal` | Bring a shared terminal back after closing its tab. |
| `Ferroshare: Go to Participant` | Jump to someone's cursor. |
| `Ferroshare: End / Leave Session` | End the session (host) or leave it (guest). |

## Settings

| Setting | Default | |
|---|---|---|
| `ferroshare.relayUrl` | `ws://localhost:7777` | Relay to host sessions on. Must be reachable by your guests. |
| `ferroshare.displayName` | your OS user name | Name shown to other participants. |
| `ferroshare.daemonPath` | bundled | Use your own build of the `mls` daemon. |

## Platforms

Daemons for **Windows x64** and **Linux x64** are bundled (the Linux one is static, so it runs on any distro and in WSL). On macOS or ARM Linux, build it with `cargo build --release -p mls` and set `ferroshare.daemonPath`.

## Security

Treat an invite link like a password: anyone with the whole link can join, and can read and change files in the shared folder (except `.git/`). A **read/write** terminal lets guests run any command on the host's computer, so only share one with people you trust. Whoever runs the relay can see who is connected and when, and can end sessions, but can't read or change any code.

## Known limitations

- No port forwarding, debugging or quick fixes yet.
- A shared terminal fits the smallest panel anyone has open, so one small panel makes it small for everyone.
- Only the first workspace folder is shared.
- If the host's connection to the relay drops, the session ends.
