import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

const certDir = path.resolve(__dirname, "certs");
const useHttps =
  process.env.SYNCPLAYER_HTTPS === "1" &&
  fs.existsSync(path.join(certDir, "dev-key.pem")) &&
  fs.existsSync(path.join(certDir, "dev-cert.pem"));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@sync-core-wasm": path.resolve(__dirname, "../../crates/sync-core/pkg/sync_core.js")
    }
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    https: useHttps
      ? {
          key: fs.readFileSync(path.join(certDir, "dev-key.pem")),
          cert: fs.readFileSync(path.join(certDir, "dev-cert.pem"))
        }
      : undefined,
    fs: {
      allow: [path.resolve(__dirname, "../..")]
    }
  }
});
