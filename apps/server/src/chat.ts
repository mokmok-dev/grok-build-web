import type { ServerNotification } from "@grok-build-web/acp-protocol";
import type { AcpClientShape } from "@grok-build-web/acp-client";
import {
  emptyAgUiState,
  errorRun,
  finishRun,
  finishTurn,
  mapSessionUpdate,
  startRun,
  type AgUiEvent,
} from "@grok-build-web/task-model";
import { Effect, Fiber, Queue, Ref, Scope, Stream } from "effect";
import type { TaskRegistryShape } from "./tasks.ts";

export interface ChatInput {
  readonly threadId: string;
  readonly runId: string;
  readonly text: string;
}

const encoder = new TextEncoder();

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

    const stateRef = yield* Ref.make(emptyAgUiState());

    const forward = (notification: ServerNotification) =>
      Effect.gen(function* () {
        if (notification.kind !== "session_update") return;
        const state = yield* Ref.get(stateRef);
        const mapped = mapSessionUpdate(state, notification.update);
        yield* Ref.set(stateRef, mapped.state);
        for (const event of mapped.events) yield* Queue.offer(queue, event);
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
      const finished = finishTurn(yield* Ref.get(stateRef));
      for (const event of finished.events) yield* Queue.offer(queue, event);
      yield* Queue.offer(queue, finishRun(input.threadId, input.runId, result.usage));
    }).pipe(
      Effect.catchTag("AcpError", (error) => Queue.offer(queue, errorRun(error.message))),
      Effect.onInterrupt(() => registry.cancel(sessionId).pipe(Effect.ignore)),
    );

    yield* Effect.forkScoped(turn);
    return Stream.fromQueue(queue).pipe(
      Stream.takeUntil((event) => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR"),
      Stream.map(sseFrame),
    );
  });
