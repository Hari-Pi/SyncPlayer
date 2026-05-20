# Peer-To-Peer Model

SyncPlayer should not require a hosted playback or sync server.

The default model is:

```text
Peer A browser
  WebRTC DataChannel
Peer B browser
```

Playback state moves over WebRTC. Media usually stays local to each user unless
we explicitly add peer media transfer later.

## Signaling Boundary

WebRTC needs an initial offer/answer exchange. Keep that separate from sync:

- Manual invite: fully serverless copy/paste or QR exchange.
- Optional signaling adapter: convenience-only exchange of offers and answers.
- No hosted media, playback authority, or persistent room state.

