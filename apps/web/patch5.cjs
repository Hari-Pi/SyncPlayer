const fs = require("fs");
let pr = fs.readFileSync("src/app/App.tsx", "utf-8");

// 1. Add localActionLockoutRef
const remoteApplyIndex = pr.indexOf("  const remoteApplyRef = useRef(false);");
pr = pr.substring(0, remoteApplyIndex) + "  const localActionLockoutRef = useRef(0);\n" + pr.substring(remoteApplyIndex);

// 2. Update publishSnapshot to set the lockout
const publishSnapshotStart = pr.indexOf("  const publishSnapshot = useCallback((isManual = false) => {");
const setSnapshotIndex = pr.indexOf("    setSnapshot(nextSnapshot);", publishSnapshotStart);
pr = pr.substring(0, setSnapshotIndex) + "    if (isManual) localActionLockoutRef.current = performance.now();\n" + pr.substring(setSnapshotIndex);

// 3. Update handleRemotePlayback to respect the lockout
const handleRemoteStart = pr.indexOf("  const handleRemotePlayback = useCallback(");
const ifElementIndex = pr.indexOf("      if (!element || !currentMedia) {", handleRemoteStart);
const newBlock = `      if (!element || !currentMedia) {
        log("warn", "SYNC", \`No media element or media mounted yet. Skipping remote state.\`);
        return;
      }

      // Ignore incoming snapshots for a short window after a manual action to prevent 
      // in-flight routine updates from overriding our manual local state changes.
      if (performance.now() - localActionLockoutRef.current < 750) {
        return;
      }`;
pr = pr.substring(0, ifElementIndex) + newBlock + pr.substring(pr.indexOf("      }", ifElementIndex) + 7);

fs.writeFileSync("src/app/App.tsx", pr);
