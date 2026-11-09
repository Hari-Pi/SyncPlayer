# SyncPlayer Handbook

A map of the codebase: what each file does, the key functions, and how data flows.
Written from reading the source (not generated from the docs), so line numbers are
approximate and will drift. Search by name.

## 1. What it is

Peer-to-peer synchronized playback in the browser. One **host** controls playback;
**guests** follow. No media or sync server: a public PeerJS broker is used only for
the WebRTC handshake. Local files are streamed host → guest over WebRTC data
channels; remote URLs (direct, HLS, DASH) are just shared as links.

Stack: React 19 + Vite 7 + TypeScript, `peerjs`, `artplayer` (video UI), `hls.js`,
`dashjs`, `qrcode`. pnpm workspace; only `apps/web` has real code today.

## 2. Repo layout

```
apps/web/                  the app (@syncplayer/web)
  index.html, vite.config.ts   alias "@" -> src; optional HTTPS via SYNCPLAYER_HTTPS=1 + certs/
  patch*.cjs, test_mp4box.js   one-off scratch scripts, not part of the app
  src/
    main.tsx               entry: OPFS cleanup on boot, renders <App/>
    app/App.tsx            ~2500 lines: all UI + playback/sync/transfer-receive logic
    features/
      room/usePeerRoom.ts  ~1500 lines: all WebRTC/PeerJS logic (host + guest)
      transfer/opfsCleanup.ts
      activity-log/activityLog.ts
    components/room/       ActivityLogPanel, FileProgressBar
    lib/
      webrtc/messages.ts   wire protocol types + CHUNK_SIZE
      webrtc/peerjsCompat.ts
      media/               mediaTypes.ts, checksum.ts
      sync/localTabSync.ts BroadcastChannel between tabs
      wasm/syncCore.ts     JS stand-ins (name says wasm; no wasm yet)
      time/format.ts, ui/cx.ts
    workers/fileWorker.ts  chunk + hash a File off the main thread
    styles/global.css
docs/                      architecture / protocol / design notes (partly aspirational)
scripts/prepare-vercel-output.mjs, vercel.json   deploy
desktop-import/            untracked, not part of the build
```

Empty `.gitkeep` folders (`crates/`, `packages/shared`, `tests/`, `features/playback`,
etc.) are placeholders. Note `docs/protocol/sync-messages.md` describes an earlier
protocol plan; the real one is `WireMessage` in `messages.ts`.

Commands (root): `pnpm dev`, `pnpm dev:https`, `pnpm build`, `pnpm typecheck`.

## 3. Roles and connection lifecycle

`RoomRole = solo | host | guest`. `LinkStatus = idle | pairing | awaiting-approval |
connected | disconnected | failed | declined`.

**Host** (`createHostOffer`)
1. Picks a room code (`genRoomCode`, 4 digits) and peer ID `SP-<code>`; creates a PeerJS `Peer`.
2. On each incoming `connection`: runs `setupConnectionDiagnostics`; on `open`, either
   `acceptConnection` (if "allow all connections" is on, or the peer was already
   accepted) or queues it in `pendingConnectionsRef` and shows a `PendingJoinRequest`.
   Unanswered requests auto-decline after 2 min (`PENDING_REQUEST_TIMEOUT_MS`).
3. `respondToJoinRequest(peerId, accept)` applies one decision to all of that peer's channels
   (`peerDecisionRef` remembers it for channels still handshaking).
4. `acceptConnection` sends `room.hello`; `declineConnection` sends `room.joinDeclined`.

**Guest** (`joinWithOffer`)
1. A bare 4-digit code becomes `SP-XXXX`. Creates peer `SP-GUEST-<5 chars>`.
2. Opens **4 parallel data channels** (`NUM_CHANNELS`, staggered 350 ms) to the host.
   Channel 0 carries the approval handshake. Multiple channels raise file throughput.
3. If ICE negotiation fails on channel 0, retries once in **TURN relay-only** mode.
4. `App.tsx` auto-reconnects a dropped guest with exponential backoff (2s → 16s cap).

**Invite links**: `App.tsx` `encodeSharePayload`/`createShareUrl`/`readSharePayloadFromUrl`
put `{type:"invite", offer, media, rtcConfig}` in the URL; opening it auto-joins and,
for remote-URL media, mounts the same URL. Custom TURN config in a link is saved to
`localStorage`.

`localStorage` keys: `syncplayer:peerserver` (custom PeerJS server, may include `config`),
`syncplayer:rtcconfig` (ICE servers/policy), `syncplayer:allowallconnections`.

## 4. Wire protocol (`lib/webrtc/messages.ts`)

Every message: `{ id, type, sentAt, payload }` (`WireMessage` union).

| type | direction | purpose |
|---|---|---|
| `room.hello` | host→guest | handshake complete / accepted |
| `room.joinDeclined` | host→guest | request refused |
| `playback.state` | host→guests | `PlaybackSnapshot` {mediaId, position, duration, paused, playbackRate} |
| `playback.guestAction` | guest→host | viewer pause/resume/seek, reverse-synced (rate-limited) |
| `clock.ping` / `clock.pong` | both | RTT measurement |
| `sync.health` | guest→host | {stalled, bufferedAheadSecs}; host adapts broadcast cadence |
| `media.mount` | host→guests | load a remote URL (`RemoteMediaMount`) |
| `file.meta` | host→guest | start of transfer (`FileMeta`: name, size, mime, totalChunks…) |
| `file.resume` | guest→host | reply with chunk ranges already held (empty = fresh) |
| `file.chunk` | host→guest | {mediaId, index, total, data, checksum} |
| `file.progress` | guest→host | cumulative chunks received (throttled) |
| `file.end` | host→guest | whole-file checksum |
| `file.aborted` | host→guest | sender failed; stop waiting |
| `config.request/state/changed` | both | sync subtitle track / quality level (`PlaybackConfig`) |

`CHUNK_SIZE` = 64 KiB. `FileMeta.isBlob` is currently always `true` (full-file
transfer); the "MSE progressive" branch is vestigial.

## 5. `usePeerRoom.ts` — the networking hook

`usePeerRoom({ onPlaybackState, onEvent, onFileStream, onMediaMount, onConfig*,
onGuestAction, allowAllConnections })` returns state (`role, status, roomCode,
latencyMs, connectedPeers, fileSendProgress, fileReceiveProgress, peerFileProgress,
pendingRequests`) and actions (`createHostOffer, joinWithOffer, closeRoom,
respondToJoinRequest, pingPeer, sendPlaybackState, sendMediaMount, sendConfig*,
reportSyncHealth, sendGuestAction, sendFileResume, sendFile`).

Callbacks are held in refs (`onEventRef`, `roleRef`, …) so long-lived DataChannel
listeners never see stale closures.

Helpers (module level):
- `createPeer` / `createRtcConfig` / `getPeerServerConfig` — build the PeerJS peer; defaults
  to Google + Cloudflare STUN and PeerJS TURN servers; overridable via `localStorage`.
- `setupConnectionDiagnostics` — logs ICE candidate types / state, restarts ICE on failure.
- `waitForDrain` — flow control: waits until the channel's `bufferedAmount` < 256 KB
  (pause above 4 MB, `FLOW_HIGH/LOW_WATERMARK`) and PeerJS's own queue is empty.
- `describeConnectionError`, `waitForPeerOpen`, `genRoomCode`.

Core functions:
- `send` / `sendToOne` — wrap a payload in an envelope and send on a connection.
- `sendPlaybackState` — host broadcast, **per-peer adaptive cadence**: each peer has a
  `PeerHealthState`; interval steps through `BROADCAST_STEPS_MS` [250,500,750,1000] up
  after 3 consecutive stall reports, down after 8 healthy ones.
- `handleMessage` — the big switch for every incoming message. Highlights:
  `clock.pong` → EWMA latency over last 8 RTT samples; `file.*` → invokes
  `FileStreamHandlers`, throttles `file.progress` echoes to 250 ms; `playback.guestAction`
  → **host-side rate limit** (3 pause/seek per 60 s per peer; resume exempt) then
  `onGuestAction`; `sync.health` → adjusts cadence.
- `sendFile(file, mediaId, …targetPeerIds?)` — see section 7.
- `closeRoom` — tears down peers, connections, timers, pending state.
- `pingPeer` — sends `clock.ping`; pong gives latency.

## 6. `App.tsx` — UI and playback sync

One big component plus small helpers.

Module helpers: `getBufferedAheadSecs`, `readDrift`, `Panel`, `Metric`,
`PendingJoinRequests`, `QrModal`, `copyText`, `describeMediaErrorCode`, share-link
encode/decode, `readStoredRtcConfig`/`writeStoredRtcConfig`, `createRemoteMedia`.

### Drift correction (`readDrift` + `handleRemotePlayback`)
Guest computes `drift = localTime − (hostPosition + latency)` (latency added only when
playing), averaged over the last 3 samples. Then:

| |drift| | mode | action |
|---|---|---|
| < 40 ms | hold | none |
| 40–150 ms | soft | playbackRate ±5% |
| 150–500 ms | firm | playbackRate ±10% |
| ≥ 500 ms | seek | hard seek (1.5 s cooldown) |

Guard: if behind (needs speed-up) with < 1.5 s buffered, hold instead — avoids the
stall → correct → stall loop. Also guards against false user-seek detection:
`remoteApplyRef`, `lastProgrammaticSeekRef` (matches the resulting position within
0.75 s), and `localPauseIntentRef` (a viewer's own pause wins for 2 s against stale
snapshots).

### Host publishing
`publishSnapshot` runs every 250 ms (and on manual actions): reads the media element,
updates local snapshot, and (as host) `sendPlaybackState`; also posts to other tabs
via `createLocalTabChannel`.

### Viewer controls
`handlePlaybackAction` / `handlePause` / `handleResume` / `handleSeeked`: guests may
pause/resume/seek; these are forwarded with `sendGuestAction` under a client-side copy
of the rate limit (`GUEST_ACTION_LIMIT`), and the host enforces it again.

### Loading media
- `handleLocalFile` — host picks a file; makes a blob URL; `createMediaHint`; as host,
  starts `room.sendFile`.
- `handleRemoteUrl` / `mountRemoteMedia` / `handleRemoteMediaMount` — URL media; format
  from `inferMediaFormat`; host broadcasts `media.mount`.
- Big `useEffect`s (~line 1580+) attach media: native element, **hls.js**, **dash.js**,
  and the **Artplayer** UI for video; a plain `<audio>` path for audio. Subtitle and
  quality choices sync through `handleConfigRequest/State/Changed`.
- `reportMediaError` / `describeMediaErrorCode` — human-readable media errors.

### Receiving a file (`handleFileStream`, guest)
Given a `FileMeta`, returns `FileStreamHandlers {onChunk, onEnd, onProgress,
alreadyReceivedCount, onAbort}`. State lives in `activeFileWriteRef` (`ActiveFileWrite`).
- If already complete for this mediaId → replies "have everything" (`file.resume`).
- If partially received (reconnect) → resumes; replies with `indicesToRanges(received)`.
- Storage: writes each chunk to its byte offset in an **OPFS** file
  `syncplayer-transfer-<mediaId>` (`storageMode: "opfs"`), falling back to in-memory
  chunks (`"memory"`). A `writeQueue` promise chain serializes writes.
- On `onEnd`: verifies `combineChecksums(received)` against the host's checksum, reads
  the file, `URL.createObjectURL`, mounts it for playback.
- `cleanupOpfsFile` removes the temp file; `cleanupOrphanedOpfsFiles` (on boot) removes
  leftovers.

### Host-approval UI
`PendingJoinRequests` renders the queue from `room.pendingRequests`; accept/decline call
`room.respondToJoinRequest`. "Allow all connections" toggle persists to `localStorage`.

## 7. File transfer pipeline (host → guest)

```
sendFile
 ├─ cancel any previous transfer to the same peers (per-peer token)
 ├─ group open connections by peer; send file.meta on ONE conn per peer
 ├─ wait ≤500 ms (RESUME_ACK_TIMEOUT_MS) for each peer's file.resume
 │    → peerSkipRanges: chunks that peer already has
 ├─ spawn min(hardwareConcurrency, 8) fileWorker.ts workers, each owns a chunk range
 │    worker: file.slice → arrayBuffer → chunkChecksum(index, bytes) → postMessage (transferable)
 ├─ main thread: chunkQueue → drainQueue()
 │    for each peer: skip if in skipRanges, else round-robin across its 4 channels,
 │    waitForDrain before sending (backpressure)
 ├─ on all workers done + queue empty: send file.end { combineChecksums(all) }
 └─ finally clear fileSendProgress; on error → terminate workers + file.aborted
```

Chunks may arrive out of order; the receiver writes by index. `background` in
`FileSendProgress` marks top-ups to late joiners (don't lock the host UI).

## 8. Library modules

- `lib/media/mediaTypes.ts` — `MediaKind` (`video|audio|unknown`), `MediaFormat`
  (`direct|hls|dash|unknown`), `LoadedMedia`, `inferMediaFormat`, `inferMediaKind`,
  `mediaFormatLabel`. Detection by MIME or URL extension.
- `lib/media/checksum.ts` — `fnv1aHash` (64-bit FNV-1a via BigInt, 16 hex chars),
  `chunkChecksum(index, data)` (hashes index + bytes, catches misplaced chunks),
  `combineChecksums(map, total)` (hash of per-chunk checksums; "missing" for gaps),
  `indicesToRanges`, `rangesInclude`. Integrity here targets app-level bugs; WebRTC
  already protects against bit flips.
- `lib/wasm/syncCore.ts` — `createMediaHint(size, duration, modifiedMs)` (32-hex file
  identity hint), `smoothLatencySync(samples)` (EWMA α=0.25), `DriftReading` type. It is
  plain JS; a Rust crate (`crates/sync-core`) is planned in the README but absent.
  Note the duplicate private FNV implementation here vs `checksum.ts`.
- `lib/webrtc/peerjsCompat.ts` — `getQueuedChunkCount(conn)`: reads PeerJS's internal
  `bufferSize`, which its types omit. Re-check on PeerJS upgrades (pinned 1.5.x).
- `lib/sync/localTabSync.ts` — `createLocalTabChannel`: `BroadcastChannel` named
  `syncplayer-local-tabs` for same-browser multi-tab testing; returns `{peerId, post, close}`.
- `lib/time/format.ts` — `formatClock`, `formatDuration` (mm:ss / hh:mm:ss), `formatBytes`.
- `lib/ui/cx.ts` — classnames joiner.
- `features/activity-log/activityLog.ts` — `createActivity(level, label, detail)`;
  levels `info|ok|warn|error`. App's `log()` appends these; `ActivityLogPanel` shows them
  and `copyActivityLogs` exports.
- `components/room/FileProgressBar.tsx` — progress bar for send/receive.
- `workers/fileWorker.ts` — protocol: in `{start|cancel}`, out `{ready|chunk|worker_done|error}`.

## 9. Tuning constants (where to change behavior)

| Constant | File | Value |
|---|---|---|
| `CHUNK_SIZE` | messages.ts | 64 KiB |
| `DRIFT_HOLD/SOFT/FIRM_MS` | App.tsx | 40 / 150 / 500 |
| `SOFT_RATE` / `FIRM_RATE` | App.tsx | 0.05 / 0.10 |
| `MIN_SAFE_BUFFER_SECS` | App.tsx | 1.5 |
| `SEEK_COOLDOWN_MS` | App.tsx | 1500 |
| `DRIFT_SMOOTHING_SAMPLES` | App.tsx | 3 |
| `LOCAL_PAUSE_INTENT_GRACE_MS` | App.tsx | 2000 |
| `GUEST_ACTION_LIMIT` / `_WINDOW_MS` | App.tsx + usePeerRoom.ts | 3 / 60 s (duplicated) |
| `BROADCAST_STEPS_MS` | usePeerRoom.ts | 250–1000 |
| `FLOW_HIGH/LOW_WATERMARK` | usePeerRoom.ts | 4 MB / 256 KB |
| `RESUME_ACK_TIMEOUT_MS` | usePeerRoom.ts | 500 |
| `PROGRESS_ECHO_INTERVAL_MS` | usePeerRoom.ts | 250 |
| `PENDING_REQUEST_TIMEOUT_MS` | usePeerRoom.ts | 2 min |
| `NUM_CHANNELS` / `CHANNEL_STAGGER_MS` | usePeerRoom.ts | 4 / 350 |

## 10. Gotchas

- Room codes are only 4 digits; the host approval queue (default) is the real protection.
- `App.tsx` and `usePeerRoom.ts` are very large; most changes touch one of them.
- The guest rate limit constants live in two places; keep them in sync.
- Secure origin (HTTPS or localhost) is needed for OPFS and clipboard; use
  `pnpm dev:https` for LAN/mobile testing.
- Browser OPFS missing → silent in-memory fallback; large files then need the tab to stay open.
- Docs in `docs/` and parts of the README describe planned work (Rust/WASM, manual
  copy/paste signaling) that the code doesn't implement yet.

## 11. Reliability changes (latest)

- **Sender** (`sendFile`): workers read ahead under a credit window (`fileWorker.ts`, 32 chunks each),
  so memory stays bounded. One send loop and queue per peer; a viewer whose buffer stays above the
  low watermark for 15 s (`SEND_STALL_TIMEOUT_MS`) or whose channels all close is dropped, not waited on.
- **Receiver** (`features/transfer/fileReceiver.ts`, extracted from `App.tsx`): re-hashes every chunk
  against the sender's checksum, discards bad ones, and after `file.end` asks the host (`file.retry`)
  to re-send gaps, up to 3 times. Disk-write failure and "no OPFS + file > 1 GiB" send `file.aborted` to the host.
- **Protocol**: `PROTOCOL_VERSION` in `room.hello`; `isWireMessage` validates every incoming message;
  `handleMessage` is wrapped in try/catch. New message `file.retry` (guest→host); `file.aborted` now also flows guest→host.
- **Host**: re-registers with the signaling broker on disconnect (`attachSignalingRecovery`), and picks a
  new room code if the chosen one is taken (`unavailable-id`).
- **Guest**: auto-reconnect gives up after 6 attempts and shows "Retry Connection".
- **Shared modules**: `lib/sync/drift.ts` (`readDrift`, `getBufferedAheadSecs`), `lib/sync/limits.ts`
  (guest action limit). Tests: `pnpm test` (vitest) covers drift, checksums, media inference, message validation.

## 12. Later additions

- **Receiving UI**: the guest's player area shows `ChunkTransferView` (canvas grid, one cell per chunk, plus received/left counts) while a file downloads; there is no separate progress bar.
- **Playback errors**: a failed load shows an opaque banner in place of the player (`media-load-error-overlay`), with "Show player anyway". Local/received (`blob:`) files get a format/codec message, ArtPlayer's own retries are off for them, and dead-URL recovery runs once per media.
- **Host upload lock**: `releaseUploadLock` / "Start playback anyway" turns the lock into a background transfer.
- **Safari/iOS writer**: `workers/opfsWriter.ts` (sync access handle) is used when `createWritable` is missing; force it with `localStorage["syncplayer:forceopfsworker"] = "true"`.
- **Logs**: the panel shows the latest 200 entries; `getAllActivity()` holds everything (Copy Logs, crash screen). `ErrorBoundary` wraps the app.
- **Invites** leave out relay usernames/passwords unless `localStorage["syncplayer:sharecredentials"] = "true"`.
- **Relays**: the dead `eu-0/us-0.turn.peerjs.com` servers were removed; configure your own (README).
- **Extracted from App.tsx**: `components/ui/Panel.tsx`, `components/room/{PendingJoinRequests,QrModal}.tsx`, `lib/share/sharePayload.ts`, `lib/media/mediaErrors.ts`, `lib/ui/clipboard.ts`. QR code library loads on demand.
- **Tooling**: `pnpm lint` (eslint), `pnpm test` (vitest), `pnpm test:e2e` (Playwright, two real tabs; needs the public PeerJS broker; set `PW_CHROMIUM_PATH` to use an installed Chromium). CI: `.github/workflows/ci.yml`.
