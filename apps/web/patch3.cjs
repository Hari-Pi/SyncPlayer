const fs = require("fs");
let pr = fs.readFileSync("src/features/room/usePeerRoom.ts", "utf-8");

const sendStart = pr.indexOf("  const send = useCallback((type: WireMessage[\"type\"], payload: WireMessage[\"payload\"]) => {");
const sendToOneStart = pr.indexOf("  const sendToOne = useCallback((conn: DataConnection, type: WireMessage[\"type\"], payload: WireMessage[\"payload\"]) => {");
const sendToOneEnd = pr.indexOf("  }, []);", sendToOneStart) + 9;

if (sendToOneStart > sendStart) {
  const sendToOneBlock = pr.substring(sendToOneStart, sendToOneEnd);
  // Remove sendToOne from its current position
  pr = pr.substring(0, sendToOneStart) + pr.substring(sendToOneEnd);
  // Insert sendToOne before send
  pr = pr.substring(0, sendStart) + sendToOneBlock + "\n\n" + pr.substring(sendStart);
}

fs.writeFileSync("src/features/room/usePeerRoom.ts", pr);
