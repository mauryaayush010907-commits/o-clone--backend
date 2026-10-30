// Vitest configuration for the standalone backend.
//
// We explicitly exclude the standalone frontend's Playwright e2e tests
// (`frontend/e2e/*.spec.js`) from vitest's test discovery, because those
// files are intended to be run with Playwright (`npm run test:e2e`),
// not vitest.
import { defineConfig } from "vitest/config";

export default defineConfig({
  css: {
    postcss: {
      plugins: [],
    },
  },
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "../frontend/e2e/**",
      "../frontend/dist/**",
    ],
  },
});
