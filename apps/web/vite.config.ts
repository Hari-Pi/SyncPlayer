import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@sync-core-wasm": path.resolve(__dirname, "../../crates/sync-core/pkg/sync_core.js")
    }
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname, "../..")]
    }
  }
});

