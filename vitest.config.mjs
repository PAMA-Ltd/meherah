import { createRequire } from "node:module";
import { join } from "node:path";

// Keep test tooling outside the frozen application dependencies when requested.
const require = createRequire(
  process.env.MEHERAH_TEST_RUNTIME
    ? join(process.env.MEHERAH_TEST_RUNTIME, "package.json")
    : import.meta.url
);

const config = {
  resolve: {
    alias: {
      "convex-test": require.resolve("convex-test"),
      vitest: join(require.resolve("vitest/package.json"), "..", "dist", "index.js"),
    },
  },
  test: { environment: "edge-runtime", include: ["convex/**/*.test.mjs"] },
};

export default config;
