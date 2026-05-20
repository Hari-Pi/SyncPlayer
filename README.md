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
- Direct media URL mounting for common progressive files such as MP4, WebM, OGG, MP3, WAV, M4A, AAC, FLAC, and Opus.
- HLS `.m3u8` online stream playback through native browser support or `hls.js`.
- MPEG-DASH `.mpd` online stream playback through `dashjs`.
- Manual WebRTC offer/answer pairing.
- Shareable invite links that hide the raw WebRTC offer/answer text.
- Online media URLs are embedded into invite links, so viewers do not need to paste the URL themselves.
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

For LAN/mobile WebRTC testing, use HTTPS:

```sh
pnpm dev:https
```

Then open:

```text
https://10.0.0.3:5173/
```

The local certificate is self-signed, so mobile browsers will ask you to accept a warning before loading the app.
Firefox mobile may fail WebRTC on plain `http://10.0.0.3:5173/`.

## Production Build

```sh
pnpm build
```

## Sharing Flow

1. Select a local file or paste an online media URL.
2. Click `Copy Invite Link`.
3. Send that link to the viewer.
4. The viewer opens it. If the invite contains an online URL, their player loads it automatically.
5. The viewer sends back the copied response link.
6. Paste that response link into `Response link from viewer` and click `Finish Connection`.

Because this is serverless WebRTC, the response link is still required. A single one-way invite link cannot complete
browser-to-browser signaling without a small signaling relay.

Local files remain private to the device for now. The invite connects playback state, but viewers still need the same
file until P2P file transfer is added.
