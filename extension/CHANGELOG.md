# Changelog

## Unreleased

- Guests can create, delete, rename and move files and folders. The host's editor carries out each change after the daemon checks it against the sandbox, so unsaved changes follow a rename, and deletes go to the trash.
- Explorers update right away when files change, for the host's own changes too.
- Shared terminals: the host shares a shell that guests can watch (read-only) or type in (read/write). Late joiners see recent output.

## 0.1.0

- First release: hosting and joining sessions through a self-hosted relay, CRDT sync, end-to-end encryption, IntelliSense forwarding from host to guests, per-person undo, participant cursors and the Live Share view.
- Bundled daemons for Windows x64 and Linux x64.
