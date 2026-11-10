import {
  AcpError,
  mayCreateTerminal,
  startTerminal,
  type TerminalHandle,
  type TerminalOptions,
} from "@grok-build-web/acp-client";
import { Context, Effect, Layer, Ref, Scope } from "effect";

export interface TerminalRegistryShape {
  readonly create: (
    sessionId: string,
    options: Omit<TerminalOptions, "outputByteLimit">,
  ) => Effect.Effect<string, AcpError>;
  readonly get: (
    sessionId: string,
    terminalId: string,
  ) => Effect.Effect<TerminalHandle | undefined>;
  readonly release: (sessionId: string, terminalId: string) => Effect.Effect<void>;
  readonly kill: (sessionId: string, terminalId: string) => Effect.Effect<void>;
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

const keyOf = (sessionId: string, terminalId: string): string => `${sessionId}\u0000${terminalId}`;

export const makeTerminalRegistry = (
  options: TerminalRegistryOptions,
): Effect.Effect<TerminalRegistryShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const terminalsRef = yield* Ref.make<ReadonlyMap<string, TerminalHandle>>(new Map());
    const counterRef = yield* Ref.make(0);

    const remove = (sessionId: string, terminalId: string) =>
      Ref.modify(terminalsRef, (terminals) => {
        const key = keyOf(sessionId, terminalId);
        const handle = terminals.get(key);
        if (handle === undefined) return [undefined, terminals];
        const next = new Map(terminals);
        next.delete(key);
        return [handle, next];
      });

    const create = (sessionId: string, terminalOptions: Omit<TerminalOptions, "outputByteLimit">) =>
      Effect.gen(function* () {
        const open = (yield* Ref.get(terminalsRef)).size;
        if (!mayCreateTerminal(options.readOnly, open, options.maxTerminals)) {
          return yield* new AcpError({
            message: options.readOnly
              ? "Read-only mode: terminals are disabled"
              : "Terminal limit reached",
          });
        }
        const terminalId = `terminal-${yield* Ref.updateAndGet(counterRef, (value) => value + 1)}`;
        const handle = yield* Effect.try({
          try: () =>
            startTerminal({ ...terminalOptions, outputByteLimit: options.outputByteLimit }),
          catch: (cause) =>
            new AcpError({ message: `Cannot start ${terminalOptions.command}: ${String(cause)}` }),
        });
        yield* Ref.update(terminalsRef, (terminals) =>
          new Map(terminals).set(keyOf(sessionId, terminalId), handle),
        );
        return terminalId;
      });

    const release = (sessionId: string, terminalId: string) =>
      Effect.gen(function* () {
        const handle = yield* remove(sessionId, terminalId);
        if (handle !== undefined) handle.release();
      });

    const kill = (sessionId: string, terminalId: string) =>
      Effect.gen(function* () {
        const handle = (yield* Ref.get(terminalsRef)).get(keyOf(sessionId, terminalId));
        if (handle !== undefined) handle.kill();
      });

    const shutdown = Effect.gen(function* () {
      for (const handle of (yield* Ref.get(terminalsRef)).values()) handle.release();
      yield* Ref.set(terminalsRef, new Map());
    });

    return {
      create,
      get: (sessionId, terminalId) =>
        Effect.map(Ref.get(terminalsRef), (terminals) =>
          terminals.get(keyOf(sessionId, terminalId)),
        ),
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
