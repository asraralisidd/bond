import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@bond/shared-types": fileURLToPath(
        new URL("./packages/shared-types/src/index.ts", import.meta.url),
      ),
      "@bond/risk-engine": fileURLToPath(
        new URL("./packages/risk-engine/src/index.ts", import.meta.url),
      ),
      "@bond/attestor": fileURLToPath(
        new URL("./packages/attestor/src/index.ts", import.meta.url),
      ),
      "@bond/contract": fileURLToPath(
        new URL("./packages/contract/src/index.ts", import.meta.url),
      ),
      "@bond/midnight-adapter": fileURLToPath(
        new URL("./packages/midnight-adapter/src/index.ts", import.meta.url),
      ),
      "@bond/sdk": fileURLToPath(
        new URL("./packages/sdk/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: false,
    environment: "node",
    environmentMatchGlobs: [["apps/web/**", "jsdom"]],
    include: [
      "tests/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "apps/api/src/**/*.test.ts",
      "apps/web/src/**/*.test.{ts,tsx}",
    ],
    coverage: {
      enabled: false,
    },
  },
});
