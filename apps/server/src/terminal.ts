import {
  AcpError,
  mayCreateTerminal,
  startTerminal,
  type TerminalHandle,
} from "@grok-build-web/acp-client";
import type { TerminalOptions } from "@grok-build-web/acp-client";
import { Context, Effect, Layer, Ref, Scope } from "effect";

export interface TerminalRegistryShape {
  readonly create: (
    options: Omit<TerminalOptions, "outputByteLimit">,
  ) => Effect.Effect<string, AcpError>;
  readonly get: (id: string) => Effect.Effect<TerminalHandle | undefined>;
  readonly release: (id: string) => Effect.Effect<void>;
  readonly kill: (id: string) => Effect.Effect<void>;
  readonly shutdown: Effect.Effect<void>;
}

export class TerminalRegistry extends Context.Service<TerminalRegistry, TerminalRegistryShape>()(
  "@grok-build-web/server/TerminalRegistry",
) {}

export interface TerminalRegistryOptions {
  readonly readOnly: boolean;
  readonly maxTerminals: number;
  readonly outputByteLimit: number;
}

export const makeTerminalRegistry = (
  options: TerminalRegistryOptions,
): Effect.Effect<TerminalRegistryShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const terminalsRef = yield* Ref.make<ReadonlyMap<string, TerminalHandle>>(new Map());
    const counterRef = yield* Ref.make(0);

    const remove = (id: string) =>
      Effect.gen(function* () {
        const handle = (yield* Ref.get(terminalsRef)).get(id);
        if (handle === undefined) return undefined;
        yield* Ref.update(terminalsRef, (terminals) => {
          const next = new Map(terminals);
          next.delete(id);
          return next;
        });
        return handle;
      });

    const create = (terminalOptions: Omit<TerminalOptions, "outputByteLimit">) =>
      Effect.gen(function* () {
        const open = (yield* Ref.get(terminalsRef)).size;
        if (!mayCreateTerminal(options.readOnly, open, options.maxTerminals)) {
          return yield* new AcpError({
            message: options.readOnly
              ? "Read-only mode: terminals are disabled"
              : "Terminal limit reached",
          });
        }
        const id = `terminal-${yield* Ref.updateAndGet(counterRef, (value) => value + 1)}`;
        const handle = startTerminal({
          ...terminalOptions,
          outputByteLimit: options.outputByteLimit,
        });
        yield* Ref.update(terminalsRef, (terminals) => new Map(terminals).set(id, handle));
        return id;
      });

    const release = (id: string) =>
      Effect.gen(function* () {
        const handle = yield* remove(id);
        if (handle !== undefined) handle.release();
      });

    const kill = (id: string) =>
      Effect.gen(function* () {
        const handle = (yield* Ref.get(terminalsRef)).get(id);
        if (handle !== undefined) handle.kill();
      });

    const shutdown = Effect.gen(function* () {
      for (const handle of (yield* Ref.get(terminalsRef)).values()) handle.release();
      yield* Ref.set(terminalsRef, new Map());
    });

    return {
      create,
      get: (id) => Effect.map(Ref.get(terminalsRef), (terminals) => terminals.get(id)),
      release,
      kill,
      shutdown,
    };
  });

export const terminalRegistryLayer = (
  options: TerminalRegistryOptions,
): Layer.Layer<TerminalRegistry> =>
  Layer.effect(
    TerminalRegistry,
    Effect.acquireRelease(makeTerminalRegistry(options), (registry) => registry.shutdown),
  );
