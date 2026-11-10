import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Fiber, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { appLayer } from "./app.ts";
import { loadConfig } from "./config.ts";

const main = (): void => {
  const config = loadConfig();
  const server = HttpRouter.serve(appLayer(config), { disableListenLog: false }).pipe(
    Layer.provide(
      NodeHttpServer.layer(() => createServer(), { port: config.port, host: config.host }),
    ),
  );

  // Build inside a scope so a signal closes every layer finalizer: terminals, then the ACP socket.
  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* Layer.build(server);
      yield* Effect.never;
    }),
  );
  const fiber = Effect.runFork(program);
  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`received ${signal}, shutting down`);
    Effect.runPromise(Fiber.interrupt(fiber)).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
};

main();
