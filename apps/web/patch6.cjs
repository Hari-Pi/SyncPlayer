const fs = require("fs");
let pr = fs.readFileSync("src/app/App.tsx", "utf-8");

const startStr = "      const reading = await readDrift(element.currentTime, targetPosition, latencyMs);";
const endStr = "        element.playbackRate = remoteSnapshot.playbackRate;\n      }";

const startIndex = pr.indexOf(startStr);
const endIndex = pr.indexOf(endStr, startIndex) + endStr.length;

if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
  console.error("Could not find the drift block to replace");
  process.exit(1);
}

const newBlock = `      remoteApplyRef.current = true;
      setDrift({ driftMs: 0, mode: "hold" });

      if (Math.abs(element.currentTime - targetPosition) > 1.5) {
        element.currentTime = targetPosition;
      }
      element.playbackRate = remoteSnapshot.playbackRate;`;

pr = pr.substring(0, startIndex) + newBlock + pr.substring(endIndex);

fs.writeFileSync("src/app/App.tsx", pr);
