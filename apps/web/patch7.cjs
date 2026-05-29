const fs = require("fs");
let pr = fs.readFileSync("src/app/App.tsx", "utf-8");

// Remove onTimeUpdate
pr = pr.replace("const onTimeUpdate = () => publishSnapshotRef.current(false);", "// Time updates removed for pure controls sync");
pr = pr.replace("video.addEventListener(\"timeupdate\", onTimeUpdate);", "// video.addEventListener(\"timeupdate\", onTimeUpdate);");
pr = pr.replace("video.removeEventListener(\"timeupdate\", onTimeUpdate);", "// video.removeEventListener(\"timeupdate\", onTimeUpdate);");

// Remove imports for readDrift and quantisePositionSync
pr = pr.replace("import { createMediaHint, loadSyncCore, readDrift, quantisePositionSync, type DriftReading } from \"@/lib/wasm/syncCore\";", "import { createMediaHint, loadSyncCore, type DriftReading } from \"@/lib/wasm/syncCore\";");

fs.writeFileSync("src/app/App.tsx", pr);
