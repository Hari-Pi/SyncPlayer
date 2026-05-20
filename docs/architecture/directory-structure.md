# Directory Structure

```text
apps/web
  Browser application, UI, playback orchestration, WebRTC integration.

crates/sync-core
  Rust/WASM engine for fast local computation: fingerprints, clock math,
  drift correction, media timeline helpers, and protocol-safe primitives.

packages/shared
  TypeScript contracts shared by the web app, tests, and future tooling.

docs
  Architecture, design language, and protocol notes.

tests
  End-to-end scenarios, media fixtures, and protocol fixtures.

scripts
  Local developer automation.
```

## Web App Functional Areas

```text
apps/web/src/app
  App bootstrapping, route shell, providers, and top-level composition.

apps/web/src/components/layout
  Command-center layout, panels, top bar, side rails, and bottom console.

apps/web/src/components/ui
  Reusable low-level controls: buttons, meters, tabs, toggles, sliders,
  dialogs, tooltips, and status indicators.

apps/web/src/features/room
  Room creation, joining, invites, host/follower state, and session identity.

apps/web/src/features/peers
  Peer list, connection health, latency, clock offset, and permissions.

apps/web/src/features/playback
  Player controls, timeline, media element bridge, seek/play/pause handling,
  and sync authority decisions.

apps/web/src/features/media-library
  Local file picker, direct URL input, media identity, recent items, and
  same-file verification flow.

apps/web/src/features/sync-status
  Drift meters, buffer state, correction mode, and sync quality display.

apps/web/src/features/activity-log
  Room events, protocol messages, warnings, and command-console output.

apps/web/src/features/settings
  Theme, audio feedback, privacy, network, and accessibility preferences.
```

## Web App Libraries

```text
apps/web/src/lib/webrtc
  PeerConnection setup, DataChannel transport, ICE config, and signaling
  adapters. This should not contain UI code.

apps/web/src/lib/wasm
  WASM loading, bindings, worker bridge, and error mapping.

apps/web/src/lib/media
  Browser media element helpers, metadata extraction, URL handling, and
  playback capability checks.

apps/web/src/lib/storage
  Local persistence for preferences, recent rooms, recent media metadata,
  and non-sensitive cached state.

apps/web/src/lib/time
  Browser-side clock sampling, monotonic time helpers, and latency utilities.

apps/web/src/workers
  Web workers for fingerprinting, metadata work, protocol load tests, and
  anything that should not block the UI thread.

apps/web/src/styles
  Theme tokens, global CSS, command-center layout rules, and effects.
```

## WASM Core Areas

```text
crates/sync-core/src
  Rust source compiled to WebAssembly.

crates/sync-core/tests
  Rust tests for deterministic sync math, fingerprints, and drift decisions.
```

## Testing Areas

```text
tests/e2e
  Browser-level room, peer, playback, and reconnection flows.

tests/fixtures/media
  Tiny sample media and metadata fixtures.

tests/fixtures/protocol
  Recorded sync-message streams and edge cases.
```

