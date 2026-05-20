# SyncPlayer

Peer-to-peer synchronized playback for local files and direct online media URLs.

The app is organized around four core responsibilities:

- Web app cockpit: immersive playback UI, room controls, peer status, logs, and settings.
- WebRTC peer layer: discovery, manual invites, data channels, latency checks, and sync messages.
- WASM sync core: high-performance file fingerprinting, time math, drift decisions, and media helpers.
- Shared contracts: message schemas, media identity types, and cross-package utilities.

See [docs/architecture/directory-structure.md](docs/architecture/directory-structure.md) for the functional map.

## Current First Slice

- Vite + React command-deck interface.
- Local video/audio file mounting.
- Direct media URL mounting.
- Manual WebRTC offer/answer pairing.
- WebRTC DataChannel playback-state messages.
- Peer latency pings and transport counters.
- Rust/WASM sync helper for drift mode, drift milliseconds, suggested correction rate, and media identity hints.
- eDEX-inspired dark cockpit UI with dense side telemetry and a clear main playback surface.

## Run Locally

```sh
pnpm install
pnpm dev
```

The root `dev` command builds the WASM package first, then starts the web app.

```text
http://localhost:5173/
```

## Production Build

```sh
pnpm build
```
