import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { cleanupOrphanedOpfsFiles } from "./features/transfer/opfsCleanup";
import "./styles/global.css";

// Run background cleanup of any orphaned OPFS storage on boot
cleanupOrphanedOpfsFiles().then(count => {
  if (count > 0) console.log(`Cleaned up ${count} orphaned file transfer chunks.`);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

