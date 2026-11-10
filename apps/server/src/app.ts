import { NodeSocket } from "@effect/platform-node";
import { AcpClient, layer as acpClientLayer } from "@grok-build-web/acp-client";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { routes, startRequestHandler } from "./api.ts";
import type { ServerConfig } from "./config.ts";
import { fsBridgeLayer } from "./fs-bridge.ts";
import { projectRegistryLayer } from "./projects.ts";
import { taskRegistryLayer } from "./tasks.ts";
import { terminalRegistryLayer } from "./terminal.ts";

export const appLayer = (
  config: ServerConfig,
): Layer.Layer<never, never, HttpRouter.HttpRouter> => {
  const acp = Layer.provide(
    acpClientLayer({ url: config.acpUrl, secret: config.acpSecret }),
    NodeSocket.layerWebSocketConstructor,
  );
  const core = Layer.mergeAll(
    acp,
    projectRegistryLayer({ maxProjects: config.maxProjects }),
    fsBridgeLayer({
      allowedRoots: config.allowedRoots,
      readOnly: config.readOnly,
      maxFileBytes: config.maxFileBytes,
    }),
    terminalRegistryLayer({
      readOnly: config.readOnly,
      maxTerminals: config.maxTerminals,
      outputByteLimit: config.terminalOutputLimit,
    }),
    Layer.provide(
      taskRegistryLayer({
        maxTasks: config.maxTasks,
        promptTimeoutMs: config.promptTimeoutMs,
        permissionTimeoutMs: config.permissionTimeoutMs,
      }),
      acp,
    ),
  );

  const background = Layer.effectDiscard(
    Effect.gen(function* () {
      const client = yield* AcpClient;
      yield* Effect.addFinalizer(() => client.disconnect);
      yield* Effect.forkScoped(client.connect);
      yield* startRequestHandler(config);
    }),
  ).pipe(Layer.provide(core));

  return Layer.mergeAll(routes(config), background).pipe(Layer.provideMerge(core));
};
