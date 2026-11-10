# grok-build-web

A local web console for a running `grok agent serve` (ACP over WebSocket). It lists ACP sessions as
tasks, streams assistant text, thinking, tool calls, plans and usage, and lets you create, prompt,
cancel and close sessions, and answer permission requests.

## Requirements

- Node 24 and pnpm 12.9.0 (pinned through `packageManager`; the flake devShell provides both)
- `grok` 1.0.70+ on `PATH` for a real agent

## Quick start

```bash
pnpm install
pnpm build                    # packages -> server dist -> web dist

grok agent --always-approve serve --bind 127.0.0.1:2419 --secret testsecret &
GROK_ACP_URL=ws://127.0.0.1:2419/ws GROK_ACP_SECRET=testsecret PORT=3000 node apps/server/dist/main.js

pnpm --filter @grok-build-web/web dev   # http://127.0.0.1:5173 (proxies /api to :3000)
```

`pnpm dev` builds the packages and starts both the API server and the Vite dev server. Set
`GROK_WEB_API_URL` when the API does not listen on `http://127.0.0.1:3000`; the Vite proxy uses it.

### Tailnet access

`pnpm dev:tailnet` reads the local Tailscale address, binds Vite to that interface, and allows the
MagicDNS name and IPv4 in both Vite's host check and the API server's `Host` check. Open the printed
`http://<magicdns>:5173` URL from another device on the tailnet. The API server stays on loopback,
and Vite proxies `/api` to it.

Anyone the tailnet ACLs allow can use the console, and the console has an unauthenticated API that
executes commands in the task working directories. Scope access with Tailscale ACLs, or start with
`GROK_WEB_READ_ONLY=1` for a view-only console.

`pnpm dev:tailnet` sets `GROK_WEB_DEV_HOST` and `GROK_WEB_ALLOWED_HOSTS` for you; set them yourself
to bind Vite to another interface. For HTTPS, keep Vite on loopback and run
`tailscale serve --bg 5173` with `GROK_WEB_ALLOWED_HOSTS=<magicdns>`.

## Server environment

| Variable                                | Default                  | Meaning                                                                           |
| --------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `GROK_ACP_URL`                          | `ws://127.0.0.1:2419/ws` | ACP WebSocket URL (`ws:` or `wss:` only)                                          |
| `GROK_ACP_SECRET` / `GROK_AGENT_SECRET` | unset                    | value for the `server-key` query parameter                                        |
| `PORT` / `HOST`                         | `3000` / `127.0.0.1`     | HTTP listen address                                                               |
| `GROK_WEB_ALLOWED_ROOTS`                | empty                    | colon-separated extra roots for task cwds, files and terminals                    |
| `GROK_WEB_DEFAULT_CWD`                  | `process.cwd()`          | default task working directory, also an allowed root                              |
| `GROK_WEB_READ_ONLY`                    | unset                    | `1` rejects task creation, prompts and chat, and disables fs writes and terminals |
| `GROK_WEB_MAX_TASKS`                    | `100`                    | tasks tracked before creation is rejected                                         |
| `GROK_WEB_MAX_TERMINALS`                | `8`                      | concurrent agent terminals                                                        |
| `GROK_WEB_TERMINAL_OUTPUT_LIMIT`        | `1048576`                | bytes of output kept per terminal                                                 |
| `GROK_WEB_MAX_FILE_BYTES`               | `2097152`                | largest file the agent may read or write                                          |
| `GROK_WEB_MAX_BODY_BYTES`               | `262144`                 | largest HTTP request body accepted                                                |
| `GROK_WEB_PROMPT_TIMEOUT_MS`            | `1800000`                | a single prompt turn may not run longer                                           |
| `GROK_WEB_PERMISSION_TIMEOUT_MS`        | `300000`                 | an unanswered permission request is cancelled                                     |
| `GROK_WEB_EVENTS_HEARTBEAT_MS`          | `15000`                  | `/api/events` heartbeat interval                                                  |
| `GROK_WEB_MAX_SSE_CLIENTS`              | `16`                     | concurrent SSE streams (429 beyond it)                                            |
| `GROK_WEB_ALLOWED_ORIGINS`              | empty                    | comma-separated extra browser origins                                             |
| `GROK_WEB_ALLOWED_HOSTS`                | empty                    | comma-separated extra `Host` names (needed behind a proxy)                        |
| `GROK_WEB_DEFAULT_MODEL`                | unset                    | default model for new tasks                                                       |

Roots are resolved once against the server working directory; `/` is never accepted as a root or as a
task cwd. The web UI's _Settings_ dialog can change the URL, secret, default cwd and default model at
runtime; the server validates them and reconnects only when the URL or secret changes.

The secret is never returned by the API. `redactUrl` strips URL credentials and masks any query
parameter whose name matches `key|secret|token|password`.

## Security model

- **Bind loopback by default.** The server validates the `Host` header (a loopback name, the
  configured `HOST`, or `GROK_WEB_ALLOWED_HOSTS`) and the `Origin` (absent, same-origin, a Vite
  dev/preview port, or `GROK_WEB_ALLOWED_ORIGINS`), and rejects anything else with 403 before
  dispatch. These checks defend against CSRF and DNS rebinding only: `Host` is client-controlled
  (`curl -H 'Host: 127.0.0.1'` passes), so a non-loopback bind exposes an **unauthenticated API that
  can execute commands**. Bind to loopback, or put an authenticating proxy in front of any other
  bind.
- **JSON only.** Request bodies must be `application/json` (415 otherwise), are read with a byte cap
  (413), and malformed JSON is a 400.
- **Task cwd is a trust root.** `POST /api/tasks` rejects a cwd outside the default cwd or an allowed
  root, and `terminal/create` rejects a cwd outside the task cwd or an allowed root.
- **fs bridge.** Paths are resolved and realpathed on both sides (including symlinked roots), the
  final component is opened with `O_NOFOLLOW`, reads and writes are size-capped, and writes are
  disabled by `GROK_WEB_READ_ONLY`.
- **Terminals** are keyed by `(sessionId, terminalId)`, run in their own process group, are killed as
  a group on release, and inherit the developer environment except `GROK_ACP_SECRET` /
  `GROK_AGENT_SECRET` — the agent's shell tool needs the rest of the environment.
- **Read-only mode** rejects task creation, prompts and chat, and disables fs writes and terminals.
  It cannot stop an already-running agent turn, because the agent's own tools run inside the agent.
- **Permissions** are per task: yolo tasks auto-select `allow_once`/`allow_always`, other requests
  wait for the browser and are cancelled after the configured timeout.

## HTTP API

- `GET /api/health`, `GET /api/settings`, `PUT /api/settings`
- `GET /api/agent`
- `GET /api/tasks`, `POST /api/tasks`
- `GET /api/tasks/:id`, `POST /api/tasks/:id/prompt`, `POST /api/tasks/:id/cancel`,
  `POST /api/tasks/:id/close`, `POST /api/tasks/:id/permission`
- `POST /api/tasks/:id/chat` — AG-UI event stream for TanStack AI
- `GET /api/events` — task list snapshots as SSE, with a heartbeat

Prompts are serialized per task: a second prompt while one is running returns 400.

## Layout

```
packages/acp-protocol   JSON-RPC envelopes, ACP session and client-method schemas
packages/task-model     ACP events -> task state and AG-UI events
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
nix flake check      # the hermetic gate; commit files first
```

The Nix flake is the single gate: `pnpmTest`, `pnpmTypecheck`, `pnpmBuild`, `pnpmMutation`, `treefmt`
and `pre-commit`. There is no duplicate GitHub Actions workflow for the web stack; the existing
`nix.yaml` workflow runs the flake, so `pnpm install --frozen-lockfile`, the typecheck, the tests, the
build and the mutation gate are all exercised with the pinned pnpm version.

**Manual gate.** `pnpm e2e` is not part of the flake: it needs a real `grok agent serve`,
a built server and a Chromium the flake does not ship. The flake covers unit, integration and mutation
checks; run `pnpm e2e` by hand after `pnpm build` when changing the web UI or the ACP wiring.

`pnpm mutation` first runs `scripts/assert-mutation-scripts.mjs`, which fails when any package
lacks `"mutation": "stryker run"`, and then runs every package without `--if-present`. The flag
existed only in the scaffold and intermediate snapshots, whose stub packages had no Stryker config
yet; `pnpm -r run` skips projects without the script silently, which is why the assertion exists.

**Mutation scope.** Stryker mutates `packages/*` — `acp-protocol`, `task-model`, and the pure modules
of `acp-client` (`jsonrpc-client.ts`, `backoff.ts`, `policy.ts`) — and must keep a 100% score with a
100/100/100 threshold. `apps/*` and the Effect socket client are not mutated: their behaviour lives in
the transport, the HTTP router and the DOM, and changing them without an enormous test surface would
weaken the suite. They are covered by the server integration tests (a fake ACP WebSocket server), the
web Testing Library tests and the Playwright E2E run instead. See `stryker.base.mjs` for the shared
configuration.

Mutation runs are resource-intensive; on a shared host run one package at a time:

```bash
systemd-run --user --wait --collect --pipe \
  --unit=grok-web-mutation-acp-protocol --same-dir \
  -p MemoryAccounting=yes -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=1G -p OOMPolicy=kill \
  -- bash -lc 'cd packages/acp-protocol && pnpm mutation'
```

## Session state

Tasks live in server memory for the lifetime of the process. A server restart loses the task list, and
ACP sessions do not survive a restart. The AG-UI message ids are run-scoped, so a new turn never
appends to the previous turn's message.
