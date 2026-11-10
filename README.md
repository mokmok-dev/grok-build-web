# grok-build-web

A local web console for a running `grok agent serve` (ACP over WebSocket). It lists ACP sessions as
tasks, streams assistant text, thinking, tool calls, plans and usage, and lets you create, prompt,
cancel and close sessions, and answer permission requests.

## Requirements

- Node 24 and pnpm (the flake devShell provides both)
- `grok` 1.0.70+ on `PATH` for a real agent

## Quick start

```bash
pnpm install
pnpm build                    # packages -> server dist -> web dist

grok agent --always-approve serve --bind 127.0.0.1:2419 --secret testsecret &
GROK_ACP_URL=ws://127.0.0.1:2419/ws GROK_ACP_SECRET=testsecret PORT=3000 node apps/server/dist/main.js

pnpm --filter @grok-build-web/web dev   # http://127.0.0.1:5173 (proxies /api to :3000)
```

`pnpm dev` builds the packages and starts both the API server and the Vite dev server.

## Server environment

| Variable                                | Default                  | Meaning                                                 |
| --------------------------------------- | ------------------------ | ------------------------------------------------------- |
| `GROK_ACP_URL`                          | `ws://127.0.0.1:2419/ws` | ACP WebSocket URL                                       |
| `GROK_ACP_SECRET` / `GROK_AGENT_SECRET` | unset                    | value for the `server-key` query parameter              |
| `PORT` / `HOST`                         | `3000` / `127.0.0.1`     | HTTP listen address                                     |
| `GROK_WEB_ALLOWED_ROOTS`                | empty                    | colon-separated extra roots the agent may read or write |
| `GROK_WEB_READ_ONLY`                    | unset                    | `1` disables file writes and terminal creation          |
| `GROK_WEB_MAX_TERMINALS`                | `8`                      | concurrent agent terminals                              |
| `GROK_WEB_TERMINAL_OUTPUT_LIMIT`        | `1048576`                | bytes of output kept per terminal                       |
| `GROK_WEB_DEFAULT_CWD`                  | `process.cwd()`          | default working directory for new tasks                 |
| `GROK_WEB_DEFAULT_MODEL`                | unset                    | default model for new tasks                             |

The secret is never returned by the API; `server-key` is masked in reported URLs.

## HTTP API

- `GET /api/health`, `GET /api/settings`, `PUT /api/settings`
- `GET /api/agent`
- `GET /api/tasks`, `POST /api/tasks`
- `GET /api/tasks/:id`, `POST /api/tasks/:id/prompt`, `POST /api/tasks/:id/cancel`,
  `POST /api/tasks/:id/close`, `POST /api/tasks/:id/permission`
- `POST /api/tasks/:id/chat` — AG-UI event stream for TanStack AI
- `GET /api/events` — task list snapshots as SSE, with a 15s heartbeat

## Layout

```
packages/acp-protocol   JSON-RPC envelopes, ACP session and client-method schemas
packages/task-model     ACP events -> tasks, AG-UI events and TanStack UI messages
packages/acp-client     Effect WebSocket client, correlation, backoff, path/permission policy
apps/server             Effect HTTP server, task registry, SSE, AG-UI chat, fs/terminal bridges
apps/web                Vite + React + TanStack AI console
```

## Checks

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm mutation        # Stryker, 100% threshold per package
pnpm e2e             # Playwright against a real agent
nix flake check      # runs the same checks hermetically (commit files first)
```

Mutation testing covers `packages/acp-protocol`, `packages/task-model` and the pure modules of
`packages/acp-client` (`jsonrpc-client.ts`, `backoff.ts`, `policy.ts`). The Effect socket client and
the Node bridges are integration-tested instead, because their behaviour lives in the transport.

Mutation runs are resource-intensive; on a shared host run one package at a time:

```bash
systemd-run --user --wait --collect --pipe \
  --unit=grok-web-mutation-acp-protocol --same-dir \
  -p MemoryAccounting=yes -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=1G -p OOMPolicy=kill \
  -- bash -lc 'cd packages/acp-protocol && pnpm mutation'
```

## Session state

Tasks live in server memory for the lifetime of the process. `GET /api/tasks/:id` hydrates an
unhydrated session with `session/load`; tasks created by the server are already hydrated. A server
restart loses the task list, and ACP sessions do not survive a server restart.
