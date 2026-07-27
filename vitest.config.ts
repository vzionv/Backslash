import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./apps/web/src"),
      "@backslash/shared": path.resolve(__dirname, "./packages/shared/src"),
    },
  },
});
