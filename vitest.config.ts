import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  define: {
    // Normally injected by vite.config.ts; the tests need it too.
    __APP_VERSION__: JSON.stringify("0.0.0-test"),
  },
  test: {
    // jsdom, because preferences talk to localStorage, the hotkeys talk to
    // window, and the table/drawer tests render real components.
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    // The packaging scripts are tested as well: they decide what actually
    // ships, and "the ZIP held the wrong architecture" is not something to
    // learn from a bug report.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"],
    restoreMocks: true,
  },
});
