/**
 * createApp(config, overrides?) — the whole server as a value: platform + HTTP.
 * index.ts boots it with the real engines; tests boot it on an ephemeral port
 * with fake engines / a fake model router injected through `overrides`.
 */
import type { AddressInfo } from "node:net";
import type { AppConfig } from "./config.ts";
import { createHttpApp, type HttpApp } from "./http/server.ts";
import { createPlatform, type Platform, type PlatformOverrides } from "./platform.ts";

export interface AppOverrides extends PlatformOverrides {
  /** Start the scheduler / crash recovery / heartbeat (default true). Tests that drive ticks by hand pass false. */
  autoStart?: boolean;
  heartbeatMs?: number;
}

export interface App {
  platform: Platform;
  http: HttpApp;
  /** Listens on config.port / config.host (port 0 = ephemeral); resolves with the base URL. */
  listen(): Promise<string>;
  /** Graceful shutdown: stop accepting, abort runs (recovered next boot), close the database. */
  close(): Promise<void>;
}

export async function createApp(config: AppConfig, overrides: AppOverrides = {}): Promise<App> {
  const platform = await createPlatform(config, overrides);
  const http = createHttpApp(platform, overrides.heartbeatMs === undefined ? {} : { heartbeatMs: overrides.heartbeatMs });
  if (overrides.autoStart !== false) platform.start();
  let closed = false;
  return {
    platform,
    http,
    listen: () =>
      new Promise<string>((resolve, reject) => {
        http.server.once("error", reject);
        http.server.listen(config.port, config.host, () => {
          http.server.off("error", reject);
          const { port } = http.server.address() as AddressInfo;
          const host = config.host.includes(":") ? `[${config.host}]` : config.host;
          resolve(`http://${host}:${port}`);
        });
      }),
    async close() {
      if (closed) return;
      closed = true;
      await http.close();
      await platform.stop();
    },
  };
}
