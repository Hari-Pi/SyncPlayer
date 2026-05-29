const fs = require("fs");
let pr = fs.readFileSync("src/features/room/usePeerRoom.ts", "utf-8");

// Fix setConnectedPeers to deduplicate
pr = pr.replace(
  "setConnectedPeers((prev) => [...prev, conn.peer]);",
  "setConnectedPeers((prev) => prev.includes(conn.peer) ? prev : [...prev, conn.peer]);"
);

// Fix send to deduplicate
const sendStart = pr.indexOf("  const send = useCallback((");
const sendEnd = pr.indexOf("  }, []);", sendStart) + 9;
const oldSend = pr.substring(sendStart, sendEnd);
const newSend = `  const send = useCallback((type: WireMessage["type"], payload: WireMessage["payload"]) => {
    const conns = connectionsRef.current;
    if (conns.length === 0) return false;

    const message = {
      id: crypto.randomUUID(),
      type,
      sentAt: performance.now(),
      payload
    };

    let sent = false;
    const seenPeers = new Set<string>();
    
    conns.forEach((conn) => {
      if (conn.open && !seenPeers.has(conn.peer)) {
        seenPeers.add(conn.peer);
        sendToOne(conn, type, payload);
        sent = true;
      }
    });
    return sent;
  }, [sendToOne]);`;
pr = pr.replace(oldSend, newSend);

// Replace sendFile
const sendFileStart = pr.indexOf("  const sendFile = useCallback(");
const sendFileEnd = pr.indexOf("  const createHostOffer = useCallback(async () => {", sendFileStart);
const oldSendFile = pr.substring(sendFileStart, sendFileEnd);
const newSendFile = `  const sendFile = useCallback(
    async (file: File, mediaId: string, targetPeerIds?: string[]) => {
      const conns = targetPeerIds 
        ? connectionsRef.current.filter(c => targetPeerIds.includes(c.peer)) 
        : connectionsRef.current;
      if (conns.length === 0) return;

      const mimeType = file.type || "video/mp4";
      const { inferMediaFormat } = await import("@/lib/media/mediaTypes");
      const format = inferMediaFormat(mimeType);

      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const meta: FileMeta = {
        mediaId,
        fileName: file.name,
        fileSize: file.size,
        mimeType,
        format,
        isBlob: true,
        totalChunks
      };

      setFileSendProgress({ mediaId, fileName: file.name, chunksSent: 0, total: totalChunks, totalBytes: file.size });
      onEventRef.current(
        "info",
        "FILE",
        \`Starting blob transfer of "\${file.name}" (\${(file.size / 1024 / 1024).toFixed(1)} MB) to \${conns.length} peer connection(s)\`
      );

      // Group connections by peer ID for multiplexing
      const peerConns = new Map<string, DataConnection[]>();
      conns.forEach((c) => {
        if (!peerConns.has(c.peer)) peerConns.set(c.peer, []);
        peerConns.get(c.peer)!.push(c);
      });

      // Broadcast file.meta to ONE connection per peer
      peerConns.forEach((connections) => {
        const firstOpen = connections.find(c => c.open);
        if (firstOpen) sendToOne(firstOpen, "file.meta", meta);
      });

      const chunkQueue: Array<{ index: number; total: number; data: Uint8Array; checksum: string }> = [];
      let drainActive = false;
      let endSent = false;
      
      let workersActive = 0;
      let workersDone = 0;
      let workerError: string | null = null;
      let finalChecksum = "dummy-checksum";

      await new Promise<void>((resolve, reject) => {
        const rejectTransfer = (error: unknown) => reject(error);
        const peerConnIndex = new Map<string, number>();

        const drainQueue = async () => {
          if (drainActive) return;
          drainActive = true;

          try {
            while (chunkQueue.length > 0) {
              const chunk = chunkQueue.shift()!;
              
              // Send to each peer via round-robin over their available multiplexed connections
              for (const [peerId, connections] of peerConns.entries()) {
                const openConns = connections.filter(c => c.open);
                if (openConns.length === 0) continue;

                let cIdx = peerConnIndex.get(peerId) || 0;
                let conn = openConns[cIdx % openConns.length];
                peerConnIndex.set(peerId, cIdx + 1);

                const channel = getDataChannel(conn);
                if (channel && channel.bufferedAmount > FLOW_HIGH_WATERMARK) {
                  await waitForDrain(conn);
                }
                sendToOne(conn, "file.chunk", {
                  mediaId,
                  index: chunk.index,
                  total: chunk.total,
                  data: chunk.data,
                  checksum: chunk.checksum
                });
              }
              setFileSendProgress((prev) =>
                prev ? { ...prev, chunksSent: prev.chunksSent + 1 } : prev
              );
            }

            if (workersDone === workersActive && !endSent && chunkQueue.length === 0) {
              endSent = true;
              for (const [peerId, connections] of peerConns.entries()) {
                const firstOpen = connections.find(c => c.open);
                if (!firstOpen) continue;
                await waitForDrain(firstOpen);
                sendToOne(firstOpen, "file.end", { mediaId, checksum: finalChecksum });
                await waitForDrain(firstOpen);
              }
              onEventRef.current("ok", "FILE", \`File "\${file.name}" fully sent.\`);
              resolve();
            }
          } catch (error) {
            rejectTransfer(error);
          } finally {
            drainActive = false;
            if (chunkQueue.length > 0 || (workersDone === workersActive && !endSent)) {
              void drainQueue();
            }
          }
        };

        const NUM_WORKERS = Math.min(navigator.hardwareConcurrency || 4, 8);
        workersActive = NUM_WORKERS;
        const chunksPerWorker = Math.ceil(totalChunks / NUM_WORKERS);

        for (let w = 0; w < NUM_WORKERS; w++) {
          const startChunkIndex = w * chunksPerWorker;
          const endChunkIndex = Math.min(startChunkIndex + chunksPerWorker, totalChunks);

          if (startChunkIndex >= totalChunks) {
             workersActive--;
             continue;
          }

          const worker = new Worker(
            new URL("../../workers/fileWorker.ts", import.meta.url),
            { type: "module" }
          );

          worker.onmessage = (event: MessageEvent) => {
            const msg = event.data as { type: string; [k: string]: unknown };
            if (msg.type === "ready") return;
            if (msg.type === "error") {
              workerError = msg.error as string;
              reject(new Error(workerError));
              return;
            }
            if (msg.type === "chunk") {
              chunkQueue.push({
                index: msg.index as number,
                total: msg.total as number,
                data: msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data as ArrayLike<number>),
                checksum: msg.checksum as string
              });
              chunkQueue.sort((a, b) => a.index - b.index);
              void drainQueue();
            }
            if (msg.type === "worker_done") {
              workersDone++;
              worker.terminate();
              void drainQueue();
            }
          };

          worker.onerror = (err) => reject(new Error(err.message));

          worker.postMessage({ 
            type: "start", 
            file, 
            mediaId, 
            chunkSize: CHUNK_SIZE,
            startChunkIndex,
            endChunkIndex,
            totalChunks
          });
        }
      }).catch((err: unknown) => {
        onEventRef.current("error", "FILE", \`File transfer failed: \${err instanceof Error ? err.message : "unknown error"}\`);
      });

      if (!workerError && workersDone === workersActive) {
        setFileSendProgress(null);
      }
    },
    [sendToOne]
  );

`;
pr = pr.replace(oldSendFile, newSendFile);

fs.writeFileSync("src/features/room/usePeerRoom.ts", pr);
