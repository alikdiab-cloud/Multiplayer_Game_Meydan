import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express, { type Express } from "express";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { attachSocketRuntime, type SocketRuntime, type SocketRuntimeOptions } from "./socket.js";

const DEFAULT_PORT = 5173;
const HOST = "0.0.0.0";

export interface DevelopmentServerOptions {
  port?: number;
  projectRoot?: string;
  logUrls?: boolean;
  socketRuntimeOptions?: SocketRuntimeOptions;
}

export interface RunningDevelopmentServer {
  app: Express;
  httpServer: HttpServer;
  vite: ViteDevServer;
  socketRuntime: SocketRuntime;
  port: number;
  close: () => Promise<void>;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT must be an integer from 0 to 65535; received ${value}.`);
  }

  return port;
}

function listenOn(server: HttpServer, port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(error);
    };

    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The development server did not receive a TCP port."));
        return;
      }

      resolvePort(address.port);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolveClose, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolveClose();
    });
  });
}

function logUrls(port: number): void {
  console.info("Dama development server ready");
  console.info(`  Local:   http://127.0.0.1:${port}`);

  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  const uniqueAddresses = [...new Set(addresses)];

  if (uniqueAddresses.length === 0) {
    console.info("  Network: no non-loopback IPv4 address found");
    return;
  }

  for (const address of uniqueAddresses) {
    console.info(`  Network: http://${address}:${port}`);
  }
}

export async function startDevelopmentServer(
  options: DevelopmentServerOptions = {},
): Promise<RunningDevelopmentServer> {
  const port = options.port ?? parsePort(process.env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Port must be an integer from 0 to 65535; received ${port}.`);
  }

  const projectRoot = options.projectRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const app = express();
  app.get("/api/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  const httpServer = createHttpServer(app);
  let vite: ViteDevServer | undefined;
  let socketRuntime: SocketRuntime | undefined;

  try {
    socketRuntime = attachSocketRuntime(httpServer, options.socketRuntimeOptions);
    const viteServer = await createViteServer({
      configFile: resolve(projectRoot, "vite.config.ts"),
      root: projectRoot,
      appType: "spa",
      server: {
        middlewareMode: { server: httpServer },
        ws: { server: httpServer },
      },
    });
    vite = viteServer;

    app.use(viteServer.middlewares);

    let actualPort: number;
    try {
      actualPort = await listenOn(httpServer, port);
    } catch (error) {
      const isDefaultPortInUse =
        port === DEFAULT_PORT &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EADDRINUSE";

      if (!isDefaultPortInUse) {
        throw error;
      }

      actualPort = await listenOn(httpServer, 0);
    }

    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        let hasCloseError = false;
        let closeError: unknown;

        try {
          await socketRuntime?.close();
        } catch (error) {
          hasCloseError = true;
          closeError = error;
        }

        try {
          await viteServer.close();
        } catch (error) {
          if (!hasCloseError) {
            hasCloseError = true;
            closeError = error;
          }
        }

        try {
          await closeHttpServer(httpServer);
        } catch (error) {
          if (!hasCloseError) {
            hasCloseError = true;
            closeError = error;
          }
        }

        if (hasCloseError) {
          throw closeError;
        }
      })();

      return closePromise;
    };

    if (options.logUrls !== false) {
      logUrls(actualPort);
    }

    return { app, httpServer, vite, socketRuntime, port: actualPort, close };
  } catch (error) {
    if (socketRuntime) {
      await socketRuntime.close().catch(() => undefined);
    }
    if (vite) {
      await vite.close();
    }
    await closeHttpServer(httpServer);
    throw error;
  }
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url;
}

if (isMainModule()) {
  void startDevelopmentServer()
    .then((runningServer) => {
      const shutdown = () => {
        void runningServer
          .close()
          .then(() => console.info("Dama development server stopped"))
          .catch((error: unknown) => {
            console.error("Could not close the Dama development server cleanly.", error);
            process.exitCode = 1;
          });
      };

      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      console.error("Dama development server failed to start.", error);
      process.exitCode = 1;
    });
}
