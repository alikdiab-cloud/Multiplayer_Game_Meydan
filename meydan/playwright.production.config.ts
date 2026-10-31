import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config.js";
import { quoteCommandArgument, reserveFreePort } from "./playwright.server-config.js";

const serverEntry = resolve("dist/server/production.js");
if (!existsSync(serverEntry)) {
  throw new Error("The compiled production server is missing. Run `npm run build` before production browser checks.");
}

// Playwright loads this config again in its test workers. Seed the selected free
// port in the parent environment so every worker targets the same server.
const productionPortKey = "DAMA_PLAYWRIGHT_PRODUCTION_PORT";
const configuredPort = process.env[productionPortKey];
const port = configuredPort === undefined ? await reserveFreePort() : Number(configuredPort);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`${productionPortKey} must be a reserved TCP port; received ${configuredPort}.`);
}
process.env[productionPortKey] = String(port);
const baseURL = `http://127.0.0.1:${port}`;
process.env.DAMA_DEPLOYMENT_MODE = "production";

export default defineConfig({
  ...baseConfig,
  testMatch: "deployment.spec.ts",
  testIgnore: [],
  outputDir: "test-results/deployment-production",
  use: {
    ...baseConfig.use,
    baseURL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: quoteCommandArgument(process.execPath) + " " + quoteCommandArgument(serverEntry),
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
  },
});
