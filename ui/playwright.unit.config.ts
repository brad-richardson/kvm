import { defineConfig } from "@playwright/test";

// Unit tests for pure logic (no browser, no device). Kept separate from the
// device-backed e2e config (playwright.config.ts), which requires JETKVM_URL.
export default defineConfig({
  testDir: "./src",
  testMatch: /.*\.unit\.spec\.ts$/,
  reporter: [["list"]],
});
