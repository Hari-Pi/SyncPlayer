const fs = require("fs");
let pr = fs.readFileSync("src/features/room/usePeerRoom.ts", "utf-8");

pr = pr.replace(
  "prev === \"Awaiting peer\" ? message.payload.label : `${prev}, ${message.payload.label}`",
  "prev === \"Awaiting peer\" ? message.payload.label : prev.includes(message.payload.label) ? prev : `${prev}, ${message.payload.label}`"
);

// Now wrap guest connect loop
const connectStart = pr.indexOf("const conn = peer.connect(hostId, { reliable: true });");
const connectEnd = pr.indexOf("});", pr.indexOf("peer.on(\"error\", (err) => {", connectStart)) + 3;

if (connectStart === -1 || connectEnd === -1) {
  console.error("Could not find guest connect block");
  process.exit(1);
}

const oldConnectBlock = pr.substring(connectStart, connectEnd);

const newConnectBlock = `const NUM_CHANNELS = 4;
          for (let i = 0; i < NUM_CHANNELS; i++) {
            const conn = peer.connect(hostId, { reliable: true });
            setupConnectionDiagnostics(conn, \`Host \${hostId} [\${i}]\`, onEventRef.current);

            conn.on("open", () => {
              if (joinAttemptRef.current !== attemptId) return;

              connectionsRef.current.push(conn);
              if (i === 0) {
                setConnectedPeers([hostId]);
                setStatus("connected");
                onEventRef.current("ok", "WEBRTC", \`Joined room. Multiplexed data channels open with host.\`);
              }

              conn.send({
                id: crypto.randomUUID(),
                type: "room.hello",
                sentAt: performance.now(),
                payload: { peerId: guestId, label: \`Viewer (\${guestId.slice(9)})\` }
              });
            });

            conn.on("data", (data) => { handleMessage(conn, data); });

            conn.on("iceStateChanged", (state) => {
              const level = state === "failed" ? "error" : state === "disconnected" ? "warn" : "info";
              onEventRef.current(level, "ICE", \`Host \${hostId} [CH\${i}] ICE state: \${state}.\`);
            });

            conn.on("close", () => {
              if (joinAttemptRef.current !== attemptId || ignoredCloseConnections.has(conn)) return;

              connectionsRef.current = connectionsRef.current.filter((c) => c !== conn);
              if (connectionsRef.current.length === 0) {
                setConnectedPeers([]);
                setStatus("disconnected");
                setRemotePeer("Awaiting peer");
                onEventRef.current("warn", "WEBRTC", \`Host (\${hostId}) disconnected.\`);
              }
            });

            conn.on("error", (err) => {
              onEventRef.current("error", "WEBRTC", \`Data channel \${i} error: \${describeConnectionError(err)}\`);

              if (err.type === "negotiation-failed" && !relayOnly && i === 0) {
                ignoredCloseConnections.add(conn);
                onEventRef.current("warn", "WEBRTC", "Direct ICE negotiation failed. Retrying once with TURN relay-only mode.");
                conn.close();
                window.setTimeout(() => {
                  startGuestPeer(true);
                }, 500);
                return;
              }
              
              if (connectionsRef.current.length === 0) {
                setStatus("failed");
              }
            });
          }
        });

        peer.on("error", (err) => {
          if (joinAttemptRef.current !== attemptId) return;

          onEventRef.current("error", "PEERJS", \`Guest broker error: \${describeConnectionError(err)}\`);
          setStatus("failed");
        });`;

pr = pr.replace(oldConnectBlock, newConnectBlock);
fs.writeFileSync("src/features/room/usePeerRoom.ts", pr);
