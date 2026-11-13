import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["perch/test/**/*.test.ts", "parliament/test/**/*.test.ts?(x)"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    setupFiles: ["./perch/test/setup.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
});
