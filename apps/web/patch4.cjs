const fs = require("fs");
let pr = fs.readFileSync("src/app/App.tsx", "utf-8");

// Add roomRef
const bindMediaIndex = pr.indexOf("  const bindMediaElement = useCallback((node: HTMLMediaElement | null) => {");
pr = pr.substring(0, bindMediaIndex) + "  const roomRef = useRef<ReturnType<typeof usePeerRoom> | null>(null);\n\n" + pr.substring(bindMediaIndex);

// Add relay logic
const timeoutEndIndex = pr.indexOf("      }, 250);", bindMediaIndex) + 14;
const oldTimeout = pr.substring(timeoutEndIndex - 14, timeoutEndIndex);
const newTimeout = `      }, 250);

      // Immediately relay to other guests if we are the host
      if (roomRef.current?.role === "host") {
        roomRef.current.sendPlaybackState(remoteSnapshot);
      }`;
pr = pr.replace(oldTimeout, newTimeout);

// Assign roomRef in useEffect
const roomInitEnd = pr.indexOf("  });", pr.indexOf("  const room = usePeerRoom({")) + 5;
pr = pr.substring(0, roomInitEnd) + "\n\n  useEffect(() => {\n    roomRef.current = room;\n  }, [room]);\n" + pr.substring(roomInitEnd);

fs.writeFileSync("src/app/App.tsx", pr);
