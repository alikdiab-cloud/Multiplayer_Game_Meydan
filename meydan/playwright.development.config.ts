import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config.js";

process.env.DAMA_DEPLOYMENT_MODE = "development";

export default defineConfig({
  ...baseConfig,
  testMatch: "deployment.spec.ts",
  testIgnore: [],
  outputDir: "test-results/deployment-development",
  use: {
    ...baseConfig.use,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
