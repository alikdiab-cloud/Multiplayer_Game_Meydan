# Meydan | The Dama Club

Meydan is a browser game for Turkish Dama. It supports local two-player matches, play against a computer opponent, and online rooms with players or spectators. The application and its lockfile live in [`meydan/`](meydan/); deployment configuration lives at this workspace root.

For game rules, controls, storage behavior, and the detailed test record, see the [application guide](meydan/README.md). For online-service lifecycle and proxy configuration, see [deployment notes](meydan/docs/deployment.md) and [online-service notes](meydan/docs/online-service.md).

For the source-based architecture and implementation reference, see [technical documentation](meydan/docs/TECHNICAL_DOCUMENTATION.tex) (LaTeX source).

## Start locally

Use Node.js 22.12.0 or newer and npm. Run the commands from the application folder so npm uses the correct manifest and lockfile:

```powershell
Set-Location .\meydan
npm ci
npm run dev
```

On Windows, after `npm ci`, you can use the project launcher from either folder:

```powershell
# From the workspace root:
pwsh -File .\meydan\Start-Meydan.ps1

# Or from meydan/:
pwsh -File .\Start-Meydan.ps1
```

The launcher checks Node against `meydan/package.json`, uses Node from `PATH` first, and does not install packages or download a runtime. See the [launcher notes](meydan/README.md#windows-launcher) for `MEYDAN_NODE_PATH` and the supported project-local runtime locations.

Open the exact local URL printed by the server. `127.0.0.1` is reachable only on this computer. A printed network URL is for devices on the same LAN when that network permits connections. Neither URL publishes the app to the public Internet; that requires a separately hosted, reachable deployment. The server does not change firewall settings.

## Verify and run production locally

Run these from `meydan/` after `npm ci`:

```powershell
npm test
npm run typecheck
npm run build
npm run test:e2e
npm run test:e2e:deployment
```

`npm run test:e2e` starts an independent Playwright browser. The deployment command checks both the integrated Vite development server and the compiled production entry at a free local port. See [test commands and browser setup](meydan/tests/README.md).

To run the production server locally:

```powershell
npm run build
npm start
```

`npm start` runs `meydan/dist/server/production.js`. It serves the compiled client and Socket.IO from one Node server; it does not use Vite middleware. The server reads `PORT` and binds `0.0.0.0`.

## Render and Docker

[`render.yaml`](render.yaml), [`Dockerfile`](Dockerfile), and [`.dockerignore`](.dockerignore) are at the **parent workspace root**. The Docker build context must include this directory and its `meydan/` child. The Render Blueprint builds a single Node 24 Docker service, reads the host-provided `PORT`, and checks `/api/health`. No repository has been published and no public deployment has been configured or verified.

For a local image, run these commands from the workspace root:

```powershell
docker build -t meydan .
docker run --rm -p 10000:10000 -e PORT=10000 meydan
```

The runtime image defaults to port 10000. Behind a proxy that rewrites the public host or scheme, set `PUBLIC_ORIGIN` to the one browser-visible origin, for example `https://game.example.com` (no path, query, or fragment). Keep the browser `Origin` unchanged and forward WebSocket upgrades on `/socket.io`. The proxy and server must route each room to the same server instance. The exact rules and the repository-root change required when publishing `meydan/` alone are in [`meydan/docs/deployment.md`](meydan/docs/deployment.md).

Render's free web services can spin down after 15 minutes without incoming HTTP requests or WebSocket messages, take about a minute to wake, and may restart. The filesystem is ephemeral and monthly usage limits apply. Since room state is in memory, sleeping, a restart, or a deploy ends active matches. Keep one server instance; multi-instance coordination is unsupported. See [Render and online-service limitations](meydan/docs/deployment.md#repository-root-choices) and [room lifecycle](meydan/docs/online-service.md).

## Clean source export

From this workspace root, use PowerShell 7 or newer:

```powershell
pwsh -File .\Export-Deployment.ps1
```

The exporter creates a ZIP under `release/` from an explicit allowlist and removes author, contributor, and repository metadata only from the exported JSON copies. It excludes PDFs, credentials, generated output, archives, and unrelated parent-workspace files. The source manifest, lockfile, and original PDFs are not edited. `release/` is excluded by both `.gitignore` and `.dockerignore`.

## Workspace layout

```text
workspace root/
├── README.md                  # This workspace guide
├── .pnpm-store/               # Optional local workspace cache
├── Dockerfile                 # Parent-root Docker context
├── render.yaml                # Render Blueprint
├── .dockerignore
├── .gitignore                 # Ignores release/
├── Export-Deployment.ps1
├── release/                   # Generated ZIPs; ignored by Git and Docker
└── meydan/                    # Application root and npm project
    ├── README.md
    ├── package.json
    ├── package-lock.json
    ├── Start-Meydan.ps1
    ├── index.html
    ├── vite.config.ts
    ├── vitest.config.ts
    ├── playwright*.config.ts
    ├── tsconfig*.json
    ├── src/                    # Browser application and bot worker
    ├── shared/                 # Dama adapter, bot, and network protocol
    ├── server/                 # HTTP, Socket.IO, rooms, and clocks
    ├── public/                 # Locally served pieces and club mark
    ├── tests/                  # Unit tests, browser tests, and fixtures
    ├── docs/                   # Service/deployment notes and cover image
    ├── dist/                   # Generated production build
    ├── node_modules/           # Installed dependencies
    └── test-results/           # Ignored local browser/build evidence
```

The detailed [application README](meydan/README.md) is the starting point for playing or contributing. The [deployment guide](meydan/docs/deployment.md) explains why the Render and Docker files remain one directory above the app.
