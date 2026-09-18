import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// @tauri-apps/cli sets TAURI_DEV_HOST when running `tauri dev`.
const host = process.env.TAURI_DEV_HOST;

// package.json is the single source of truth for the version. Injecting it here
// means the window, the installer and the website all report one number and
// nobody maintains a second copy. `npm run sync-version` propagates it.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  plugins: [react()],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  // Do not let Vite clear the screen over a Rust compile error.
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  envPrefix: ["VITE_", "TAURI_ENV_"],

  build: {
    // WebView2 on Windows is evergreen Chromium, so the bundle can target it
    // directly rather than down-levelling for browsers that never run this app.
    target: "esnext",
    minify: true,
    sourcemap: false,
  },
});
