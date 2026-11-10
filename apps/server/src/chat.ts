import type { ServerNotification } from "@grok-build-web/acp-protocol";
import { AcpError, type AcpClientShape } from "@grok-build-web/acp-client";
import {
  emptyAgUiState,
  errorRun,
  finishRun,
  finishTurn,
  mapSessionUpdate,
  startRun,
  type AgUiEvent,
  type AgUiMapperState,
} from "@grok-build-web/task-model";
import { Cause, Effect, Fiber, Queue, Ref, Scope, Stream } from "effect";
import type { TaskRegistryShape } from "./tasks.ts";

export interface ChatInput {
  readonly threadId: string;
  readonly runId: string;
  readonly text: string;
}

const encoder = new TextEncoder();

const messageOf = (cause: Cause.Cause<AcpError>): string => {
  const error = Cause.squash(cause);
  return error instanceof AcpError ? error.message : String(error);
};

export const sseFrame = (payload: unknown): Uint8Array =>
  encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

export const chatSse = (
  sessionId: string,
  input: ChatInput,
  client: AcpClientShape,
  registry: TaskRegistryShape,
): Effect.Effect<Stream.Stream<Uint8Array>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<AgUiEvent>();
    const stateRef = yield* Ref.make<AgUiMapperState>(emptyAgUiState(input.runId));

    const forward = (notification: ServerNotification) =>
      Effect.gen(function* () {
        if (notification.kind !== "session_update") return;
        const mapped = mapSessionUpdate(yield* Ref.get(stateRef), notification.update);
        yield* Ref.set(stateRef, mapped.state);
        for (const event of mapped.events) yield* Queue.offer(queue, event);
      });

    const closeOpenStreams = Effect.gen(function* () {
      const finished = finishTurn(yield* Ref.get(stateRef));
      yield* Ref.set(stateRef, finished.state);
      for (const event of finished.events) yield* Queue.offer(queue, event);
    });

    const turn = Effect.gen(function* () {
      yield* Queue.offer(queue, startRun(input.threadId, input.runId));
      const subscription = yield* Effect.forkChild(
        client.notifications.pipe(
          Stream.filter(
            (notification) =>
              notification.kind === "session_update" && notification.sessionId === sessionId,
          ),
          Stream.runForEach(forward),
        ),
      );
      const result = yield* registry.promptAndWait(sessionId, input.text);
      yield* Fiber.interrupt(subscription);
      yield* closeOpenStreams;
      yield* Queue.offer(queue, finishRun(input.threadId, input.runId, result.usage));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* closeOpenStreams;
          yield* Queue.offer(queue, errorRun(messageOf(cause)));
        }),
      ),
      Effect.onInterrupt(() => registry.cancel(sessionId).pipe(Effect.ignore)),
    );

    yield* Effect.forkScoped(turn);
    return Stream.fromQueue(queue).pipe(
      Stream.takeUntil((event) => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR"),
      Stream.map(sseFrame),
    );
  });
