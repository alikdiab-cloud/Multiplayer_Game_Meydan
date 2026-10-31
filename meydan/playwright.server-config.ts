import { createServer } from "node:net";

export async function reserveFreePort(): Promise<number> {
  const probe = createServer();
  return new Promise<number>((resolvePort, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("Could not reserve an ephemeral TCP port for Playwright."));
        return;
      }
      const { port } = address;
      probe.close((error) => {
        if (error !== undefined) reject(error);
        else resolvePort(port);
      });
    });
  });
}

export function quoteCommandArgument(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}
