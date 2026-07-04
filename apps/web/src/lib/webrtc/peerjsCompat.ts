/**
 * One narrow, documented workaround for a PeerJS (currently pinned to
 * 1.5.5) typing gap, so an upgrade only requires re-checking here.
 *
 * Verified directly against node_modules/peerjs/dist/types.d.ts for 1.5.5:
 *
 * - `dataChannel` is declared on `BaseConnection` (which `DataConnection`
 *   extends) as a plain public `RTCDataChannel` field — fully typed, no cast
 *   needed. It's `undefined` until the channel actually opens, which is why
 *   call sites still null-check it, but that's a value check, not a typing
 *   workaround.
 * - `bufferSize` (chunks queued in PeerJS's own internal send buffer,
 *   distinct from the RTCDataChannel's own `bufferedAmount`) is declared
 *   only on the exported `BufferedConnection` subclass — NOT on
 *   `DataConnection` itself, even though every concrete connection PeerJS
 *   actually hands back (its binary/JSON/raw serializer classes) extends
 *   `BufferedConnection`. So the `DataConnection` type our code uses doesn't
 *   know about it, even though the real runtime object does. That's a
 *   genuine gap in how PeerJS's own type hierarchy models its exports, not a
 *   private/unstable property — hence the one narrow cast below, isolated
 *   here instead of scattered inline.
 *
 * There used to also be a speculative fallback to a `_dc` property when
 * reading the data channel; that property has never existed in any 1.x
 * release found in this repo's lockfile, so it was dead code and has been
 * removed along with the unnecessary cast around `dataChannel`.
 */

import type { DataConnection } from "peerjs";

/** How many chunks PeerJS itself is still holding in its internal send queue for this connection. */
export function getQueuedChunkCount(conn: DataConnection): number {
  return (conn as unknown as { bufferSize?: number }).bufferSize ?? 0;
}
