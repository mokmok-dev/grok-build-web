import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Exit, Fiber, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { appLayer } from "./app.ts";
import { loadConfig, type ServerConfig } from "./config.ts";

const loadOrExit = (): ServerConfig => {
  try {
    return loadConfig();
  } catch (cause) {
    console.error(
      "server failed to start:",
      cause instanceof Error ? cause.message : String(cause),
    );
    process.exit(1);
  }
};

const main = (): void => {
  const config = loadOrExit();
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
  let stopping = false;

  // Observe the build so a failure such as EADDRINUSE exits non-zero instead of hanging silently.
  void Effect.runPromise(Fiber.await(fiber)).then((exit) => {
    if (stopping) return;
    if (Exit.isFailure(exit)) {
      console.error("server failed to start:", String(exit.cause));
      process.exit(1);
    }
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    stopping = true;
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
