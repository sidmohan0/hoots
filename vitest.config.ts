import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["perch/test/setup.ts"],
    fileParallelism: false // both test files own the same SQLite ledger
  },
});
