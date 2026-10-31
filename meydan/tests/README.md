# Test commands

- `npm test` runs the Node-based Vitest checks.
- `npm run test:e2e` runs Playwright browser checks.
- `npm run test:e2e:deployment:dev` runs the deployment smoke and responsive checks against a Vite development server on an ephemeral port.
- `npm run test:e2e:deployment:production` builds the app, then starts the compiled production entry at `dist/server/production.js` on a free loopback port and runs the same checks. It does not use `vite preview` or Vite middleware.
- `npm run test:e2e:deployment` runs both modes in sequence.

The deployment smoke test checks deep-route SPA fallback, bundled static assets, the emitted bot worker, and a live Socket.IO WebSocket connection. Production mode also rejects Vite client or source-module requests. Each deployment run captures lobby, online-play, and result-state screenshots at 1440, 1024, 390, and 320 pixels wide, and checks page overflow and essential-control overlap in the lobby, match, result dialog, and finished-match states. The production 1440-by-960 match screenshot is also saved as `docs/cover.png`.

Playwright prefers installed Microsoft Edge through the `msedge` channel. If Edge is unavailable, it uses an installed Chrome or Chromium executable; set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to select another supported Chromium build. If no compatible browser is installed, install one with `npx playwright install chromium`.

Playwright traces, screenshots, and reports are written under ignored output folders (`test-results/`, `playwright-report/`, and `blob-report/`).
