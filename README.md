# SyncPlayer

<p>
  <a href="https://sync-player-web.vercel.app" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/Open%20SyncPlayer-Visit%20Site-blue?style=for-the-badge" alt="Open SyncPlayer" />
  </a>
</p>

Peer-to-peer synchronized playback for local files and direct online media URLs.

SyncPlayer is a browser-based media synchronization cockpit built for watching or listening together across devices. It combines a React web interface, WebRTC peer connections, shared playback-state messages, and a Rust/WASM sync helper to keep media sessions aligned with low overhead.

---

## Overview

SyncPlayer lets two peers connect directly through WebRTC and synchronize playback state without requiring a traditional media server.

It supports:

* Local video and audio files
* Direct online media URLs
* Progressive media files such as MP4, WebM, OGG, MP3, WAV, M4A, AAC, FLAC, and Opus
* HLS `.m3u8` streams through native browser support or `hls.js`
* MPEG-DASH `.mpd` streams through `dashjs`
* Manual peer connection through invite and response links
* Playback-state synchronization over WebRTC DataChannels
* Peer latency checks, transport counters, logs, and room telemetry

The current experience is designed around a dark, eDEX-inspired command-deck UI with a clear main playback surface and dense side telemetry for debugging and coordination.

---

## Live Demo

Open the deployed app here:

**https://sync-player-web.vercel.app**

You can use the hosted version to test online media URLs or connect two browser sessions using the manual WebRTC invite flow.

---

## Core Responsibilities

The app is organized around four main responsibilities:

### 1. Web App Cockpit

The browser UI provides:

* Immersive playback controls
* Room and peer connection controls
* Local file mounting
* Online media URL mounting
* Invite and response link handling
* Peer status indicators
* Logs, settings, and debugging telemetry

### 2. WebRTC Peer Layer

The peer layer handles browser-to-browser coordination, including:

* Manual offer and answer pairing
* Shareable invite links
* WebRTC DataChannel setup
* Peer latency checks
* Transport counters
* Playback-state message delivery

### 3. WASM Sync Core

The Rust/WASM sync helper provides performance-sensitive logic for:

* File fingerprinting
* Media identity hints
* Time math
* Drift detection
* Drift mode decisions
* Suggested correction rates
* Playback sync calculations

### 4. Shared Contracts

Shared packages define reusable types and utilities, including:

* Message schemas
* Media identity types
* Cross-package helpers
* Sync-related contracts used by both the app and lower-level modules

See [`docs/architecture/directory-structure.md`](docs/architecture/directory-structure.md) for the functional map.

---

## Current First Slice

The current implementation includes:

* Vite + React command-deck interface
* Local video and audio file mounting
* Direct media URL mounting
* Progressive file playback for common audio and video formats
* HLS `.m3u8` playback through native browser support or `hls.js`
* MPEG-DASH `.mpd` playback through `dashjs`
* Manual WebRTC offer/answer pairing
* Shareable invite links that hide raw WebRTC signaling text
* Online media URLs embedded into invite links
* Automatic online URL loading for viewers when included in the invite
* WebRTC DataChannel playback-state messages
* Peer latency pings
* Transport counters
* Rust/WASM sync helper for drift handling
* Media identity hints
* eDEX-inspired dark cockpit UI
* Dense side telemetry with a clear main media surface

---

## How Sharing Works

SyncPlayer currently uses a serverless WebRTC signaling flow.

That means there is no dedicated signaling relay yet. Instead, the host and viewer exchange invite and response links manually.

### Host Flow

1. Open SyncPlayer.
2. Select a local media file or paste an online media URL.
3. Click `Copy Invite Link`.
4. Send the invite link to the viewer.
5. Wait for the viewer to send back a response link.
6. Paste the response link into `Response link from viewer`.
7. Click `Finish Connection`.

### Viewer Flow

1. Open the invite link from the host.
2. If the invite contains an online media URL, the player loads it automatically.
3. Copy the generated response link.
4. Send the response link back to the host.
5. Once the host finishes the connection, playback sync can begin.

---

## Important Limitations

Because SyncPlayer currently uses serverless manual signaling, a single one-way invite link cannot complete the browser-to-browser connection by itself.

The viewer still needs to return a response link to the host.

Also, local files remain private to each device for now. The invite synchronizes playback state, but it does not transfer the local file. Viewers need access to the same local file until peer-to-peer file transfer is added.

Online media URLs are different: when an invite contains an online URL, the viewer can load that media automatically from the link.

---

## Supported Media Sources

### Local Files

SyncPlayer can mount local audio and video files selected from the browser.

Local files stay on the user’s device. They are not uploaded to a server.

### Direct Online URLs

SyncPlayer supports direct links to common progressive media files, including:

* `.mp4`
* `.webm`
* `.ogg`
* `.mp3`
* `.wav`
* `.m4a`
* `.aac`
* `.flac`
* `.opus`

### HLS Streams

HLS `.m3u8` streams are supported through:

* Native browser playback when available
* `hls.js` fallback when needed

### MPEG-DASH Streams

MPEG-DASH `.mpd` streams are supported through `dashjs`.

---

## Tech Stack

SyncPlayer is built with:

* **Vite** for fast web development
* **React** for the cockpit interface
* **TypeScript** for safer application code
* **WebRTC** for peer-to-peer browser connections
* **WebRTC DataChannels** for sync messages
* **Rust** for sync-core logic
* **WebAssembly** for high-performance browser execution
* **hls.js** for HLS playback fallback
* **dashjs** for MPEG-DASH playback

---

## Run Locally

Install dependencies:

```sh
pnpm install
```

Start the development server:

```sh
pnpm dev
```

The root `dev` command builds the WASM package first, then starts the web app.

Open:

```text
http://localhost:5173/
```

---

## LAN and Mobile Testing

For LAN or mobile WebRTC testing, use HTTPS:

```sh
pnpm dev:https
```

Then open the local network URL shown by the dev server, for example:

```text
https://10.0.0.3:5173/
```

The local certificate is self-signed, so mobile browsers may show a browser warning before loading the app.

Firefox mobile may fail WebRTC on plain HTTP LAN URLs such as:

```text
http://10.0.0.3:5173/
```

Use HTTPS for more reliable mobile testing.

---

## Production Build

Create a production build:

```sh
pnpm build
```

Depending on the project setup, you can preview the built app with:

```sh
pnpm preview
```

---

## Recommended Development Workflow

A typical local development loop is:

```sh
pnpm install
pnpm dev
```

Then open two browser windows or two devices:

```text
http://localhost:5173/
```

For same-machine testing:

1. Open the app in two browser tabs or windows.
2. Use one as the host.
3. Use the other as the viewer.
4. Exchange invite and response links manually.
5. Test playback-state sync.

For real device testing:

1. Start the HTTPS dev server.
2. Open the app from the LAN URL on both devices.
3. Accept the self-signed certificate warning.
4. Use the invite and response flow.

---

## Project Structure

The repository is organized around app, peer, WASM, and shared contract layers.

For a detailed map, see:

```text
docs/architecture/directory-structure.md
```

Suggested high-level structure:

```text
.
├── apps/
│   └── web/
├── crates/
│   └── sync-core/
├── packages/
│   └── shared/
├── docs/
│   └── architecture/
└── README.md
```

Actual structure may evolve as the project grows.

---

## Roadmap Ideas

Potential next improvements include:

* Signaling relay for one-click room joins
* Optional room codes
* Peer-to-peer local file transfer
* Multi-peer room support
* Better host/viewer role management
* Persistent room state
* More advanced drift correction
* Subtitle synchronization
* Playlist support
* Media metadata extraction
* Stream capability detection
* Better mobile-first controls
* Connection recovery after tab sleep or network changes
* TURN server configuration for difficult NAT environments
* End-to-end encrypted room metadata
* Import/export session logs for debugging

---

## Troubleshooting

### The viewer cannot connect

Check that:

* The host copied the invite link correctly
* The viewer opened the invite link
* The viewer copied the response link
* The host pasted the response link into the correct field
* Both browsers allow WebRTC
* Both devices have network connectivity

Some networks may block direct peer-to-peer WebRTC connections. A TURN server may be needed in the future for maximum reliability.

### Local file playback is not synced for the viewer

Local files are not transferred between peers yet.

Both users need to select the same local file manually. SyncPlayer can coordinate playback state, but it does not currently send the media file itself.

### Online media URL does not load

Check that:

* The URL points directly to a playable media resource
* The server allows browser playback
* The server provides compatible CORS headers when required
* The media format is supported by the browser or by the HLS/DASH playback layer

### Mobile browser has connection issues

Use HTTPS for LAN testing:

```sh
pnpm dev:https
```

Plain HTTP LAN URLs may cause browser restrictions, especially for WebRTC features.

---

## Privacy Notes

SyncPlayer is designed around local-first and peer-to-peer behavior.

* Local files stay on the user’s device.
* Local files are not uploaded by the app.
* WebRTC connects browsers directly when possible.
* Online media URLs included in invite links are visible to anyone who receives the invite.
* Manual invite and response links may contain connection metadata needed for WebRTC setup.

Do not share invite or response links with people who should not join the session.

---

## Contributing

Contributions are welcome.

Good areas to improve include:

* WebRTC connection reliability
* Sync accuracy
* Media compatibility
* UI polish
* Accessibility
* Mobile usability
* Documentation
* Test coverage
* WASM sync-core improvements

Before contributing, run the local development setup and test both the host and viewer flows.

---

## Development Notes

When working on SyncPlayer, keep these principles in mind:

* Keep the media experience responsive.
* Keep local files private unless the user explicitly chooses to share them.
* Prefer clear connection states over hidden magic.
* Make invite and response flows understandable.
* Keep sync messages small and explicit.
* Keep browser compatibility visible in the UI when possible.
* Treat WebRTC failures as expected network conditions, not exceptional edge cases.

---

## License

Add the project license here.

For example:

```text
MIT
```

---

## Status

SyncPlayer is in an early first-slice stage.

The foundation is in place for synchronized media playback, manual peer connection, online media URL sharing, and WASM-assisted sync decisions. Future versions can build on this foundation with easier signaling, stronger recovery, file transfer, and richer room features.
