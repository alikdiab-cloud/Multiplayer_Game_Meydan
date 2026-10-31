import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, defineConfig } from "@playwright/test";

const edgeCandidates = [
  process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe"),
  process.env.ProgramFiles && join(process.env.ProgramFiles, "Microsoft/Edge/Application/msedge.exe"),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Microsoft/Edge/Application/msedge.exe"),
].filter((path): path is string => path !== undefined);
const edgeIsInstalled = edgeCandidates.some((path) => existsSync(path));

const chromiumCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Google/Chrome/Application/chrome.exe"),
  process.env.ProgramFiles && join(process.env.ProgramFiles, "Google/Chrome/Application/chrome.exe"),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
  chromium.executablePath(),
].filter((path): path is string => path !== undefined);
const chromiumExecutable = chromiumCandidates.find((path) => existsSync(path));

if (!edgeIsInstalled && chromiumExecutable === undefined) {
  throw new Error(
    "Playwright needs Microsoft Edge or an installed Chromium browser. Install Edge, install Chromium with `npx playwright install chromium`, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a supported browser executable.",
  );
}

const browserSelection = edgeIsInstalled
  ? { channel: "msedge" as const }
  : { launchOptions: { executablePath: chromiumExecutable! } };

console.info(
  edgeIsInstalled
    ? "Playwright browser selected: Microsoft Edge through the msedge channel."
    : `Playwright browser selected: Chromium at ${chromiumExecutable}`,
);

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  testIgnore: "**/deployment.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: "./test-results",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    ...browserSelection,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
