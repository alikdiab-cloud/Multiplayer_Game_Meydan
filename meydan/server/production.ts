import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { attachSocketRuntime, type SocketRuntime } from "./socket.js";

const DEFAULT_PORT = 5173;
const HOST = "0.0.0.0";

export interface ProductionServerOptions {
  port?: number;
  clientDirectory?: string;
  logUrls?: boolean;
}

export interface RunningProductionServer {
  app: Express;
  httpServer: HttpServer;
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
        reject(new Error("The production server did not receive a TCP port."));
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
  console.info("Dama production server ready");
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

function isClientNavigation(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const pathname = request.path;
  if (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/socket.io" ||
    pathname.startsWith("/socket.io/") ||
    pathname === "/@vite" ||
    pathname.startsWith("/@vite/") ||
    pathname === "/@id" ||
    pathname.startsWith("/@id/") ||
    pathname === "/@fs" ||
    pathname.startsWith("/@fs/") ||
    pathname === "/@react-refresh" ||
    pathname === "/__vite_ping"
  ) {
    return false;
  }

  const segments = pathname.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith("."))) {
    return false;
  }

  const explicitlyAcceptsHtml = request.get("accept")?.toLowerCase().includes("text/html") === true;
  return extname(pathname) === "" && explicitlyAcceptsHtml && request.accepts("html") !== false;
}

export async function startProductionServer(
  options: ProductionServerOptions = {},
): Promise<RunningProductionServer> {
  process.env.NODE_ENV = "production";

  const port = options.port ?? parsePort(process.env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Port must be an integer from 0 to 65535; received ${port}.`);
  }

  const compiledDirectory = dirname(fileURLToPath(import.meta.url));
  const clientDirectory = options.clientDirectory ?? resolve(compiledDirectory, "../client");
  const indexFile = resolve(clientDirectory, "index.html");
  const app = express();

  app.get("/api/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "Not found" });
  });

  app.use(
    express.static(clientDirectory, {
      dotfiles: "deny",
      fallthrough: true,
      index: false,
      redirect: false,
    }),
  );

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (!isClientNavigation(request)) {
      next();
      return;
    }

    response.sendFile(indexFile, (error) => {
      if (error) {
        next(error);
      }
    });
  });

  app.use((_request, response) => {
    response.status(404).type("text/plain").send("Not found");
  });

  const httpServer = createHttpServer(app);
  const socketRuntime = attachSocketRuntime(httpServer);
  let actualPort: number;
  try {
    actualPort = await listenOn(httpServer, port);
  } catch (error) {
    await socketRuntime.close().catch(() => undefined);
    await closeHttpServer(httpServer);
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      let firstError: unknown;
      try {
        await socketRuntime.close();
      } catch (error) {
        firstError = error;
      }
      try {
        await closeHttpServer(httpServer);
      } catch (error) {
        firstError ??= error;
      }
      if (firstError !== undefined) throw firstError;
    })();
    return closePromise;
  };

  if (options.logUrls !== false) {
    logUrls(actualPort);
  }

  return { app, httpServer, socketRuntime, port: actualPort, close };
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url;
}

if (isMainModule()) {
  void startProductionServer()
    .then((runningServer) => {
      const shutdown = () => {
        void runningServer
          .close()
          .then(() => console.info("Dama production server stopped"))
          .catch((error: unknown) => {
            console.error("Could not close the Dama production server cleanly.", error);
            process.exitCode = 1;
          });
      };

      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      console.error("Dama production server failed to start.", error);
      process.exitCode = 1;
    });
}
