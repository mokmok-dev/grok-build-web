import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
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
  Effect.runPromise(Layer.launch(server)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
};

main();
