import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import * as api from "./api.ts";

const summary = {
  id: "s1",
  title: "My task",
  cwd: "/tmp/work",
  model: "m1",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  messageCount: 1,
  usage: {},
  yolo: false,
};

const detail = (patch: Record<string, unknown> = {}) => ({
  ...summary,
  messages: [{ id: "u", role: "user", createdAt: 1, parts: [{ type: "text", text: "hi" }] }],
  plan: [],
  availableCommands: [],
  configOptions: [],
  queue: [],
  ...patch,
});

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const calls: Call[] = [];

const installFetch = (
  handler: (call: Call) => { readonly status?: number; readonly body: unknown } | undefined,
): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      const call: Call = {
        method: init?.method ?? "GET",
        path,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      const result = handler(call);
      if (result === undefined) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      return new Response(JSON.stringify(result.body), {
        status: result.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
};

const baseRoutes = (call: Call): { status?: number; body: unknown } | undefined => {
  switch (call.path) {
    case "/api/health":
      return { body: { ok: true, acp: { connected: true, url: "ws://127.0.0.1:2419/ws" } } };
    case "/api/settings":
      return {
        body: {
          url: "ws://127.0.0.1:2419/ws",
          hasSecret: true,
          defaultCwd: "/tmp/work",
          readOnly: false,
        },
      };
    case "/api/agent":
      return {
        body: {
          connected: true,
          models: { availableModels: [{ modelId: "m1", name: "Model One" }] },
          availableCommands: [],
          capabilities: {},
        },
      };
    case "/api/tasks":
      return { body: { tasks: [summary] } };
    case "/api/tasks/s1":
      return { body: detail() };
    default:
      return undefined;
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
  calls.splice(0);
});

describe("App", () => {
  it("loads tasks and shows the connection state", async () => {
    installFetch(baseRoutes);
    render(<App />);
    expect(await screen.findByText("My task")).toBeTruthy();
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByText(/work · m1/)).toBeTruthy();
  });

  it("shows the disconnected state and disables new tasks", async () => {
    installFetch((call) => {
      if (call.path === "/api/health") return { body: { ok: true, acp: { connected: false } } };
      return baseRoutes(call);
    });
    render(<App />);
    expect(await screen.findByText("Disconnected")).toBeTruthy();
    expect((screen.getByRole("button", { name: "New task" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("creates a task through the dialog", async () => {
    const user = userEvent.setup();
    installFetch((call) => {
      if (call.path === "/api/tasks" && call.method === "POST") {
        return { body: detail({ id: "s2", title: "Fresh", status: "running" }) };
      }
      return baseRoutes(call);
    });
    render(<App />);
    await screen.findByText("My task");
    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.clear(screen.getByLabelText("Working directory"));
    await user.type(screen.getByLabelText("Working directory"), "/tmp/work/sub");
    await user.type(screen.getByLabelText("First prompt"), "hello");
    await user.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByRole("heading", { name: "Fresh" });
    expect(
      calls.find((call) => call.method === "POST" && call.path === "/api/tasks")?.body,
    ).toEqual({
      cwd: "/tmp/work/sub",
      prompt: "hello",
      model: undefined,
      yolo: false,
    });
  });

  it("cancels and closes the selected task", async () => {
    const user = userEvent.setup();
    installFetch((call) => {
      if (call.path === "/api/tasks/s1/cancel") return { body: { accepted: true } };
      if (call.path === "/api/tasks/s1/close") return { body: { closed: true } };
      return baseRoutes(call);
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /My task/ }));
    await screen.findByRole("button", { name: "Close" });
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(calls.some((call) => call.path === "/api/tasks/s1/close")).toBe(true);
    expect(calls.some((call) => call.path === "/api/tasks/s1")).toBe(true);
  });

  it("answers a pending permission request", async () => {
    const user = userEvent.setup();
    installFetch((call) => {
      if (call.path === "/api/tasks/s1") {
        return {
          body: detail({
            status: "awaiting_permission",
            pendingPermission: {
              requestId: "r1",
              toolCallId: "t1",
              title: "Run ls",
              options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
            },
          }),
        };
      }
      if (call.path === "/api/tasks/s1/permission") return { body: { accepted: true } };
      return baseRoutes(call);
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /My task/ }));
    await user.click(await screen.findByRole("button", { name: "Allow once" }));
    const permission = calls.find((call) => call.path === "/api/tasks/s1/permission");
    expect(permission?.body).toEqual({ requestId: "r1", optionId: "allow_once" });
  });

  it("saves settings", async () => {
    const user = userEvent.setup();
    installFetch((call) => {
      if (call.path === "/api/settings" && call.method === "PUT") {
        return {
          body: {
            url: "ws://127.0.0.1:2419/ws",
            hasSecret: true,
            defaultCwd: "/tmp/work",
            readOnly: false,
          },
        };
      }
      return baseRoutes(call);
    });
    render(<App />);
    await screen.findByText("My task");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.type(await screen.findByLabelText("Secret"), "next-secret");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const saved = calls.find((call) => call.method === "PUT" && call.path === "/api/settings");
    expect(saved?.body).toEqual({
      url: "ws://127.0.0.1:2419/ws",
      secret: "next-secret",
      defaultCwd: "/tmp/work",
      defaultModel: undefined,
    });
  });

  it("shows an API error", async () => {
    const user = userEvent.setup();
    installFetch((call) => {
      if (call.path === "/api/tasks" && call.method === "POST") {
        return { status: 400, body: { error: "Working directory is outside the allowed roots" } };
      }
      return baseRoutes(call);
    });
    render(<App />);
    await screen.findByText("My task");
    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByText("Working directory is outside the allowed roots")).toBeTruthy();
  });
});

describe("api wrappers", () => {
  it("sends the documented method, path and body", async () => {
    installFetch((call) => ({ body: call.method === "GET" ? { tasks: [] } : {} }));
    await api.fetchTasks();
    await api.cancelTask("a b");
    await api.closeTask("ab");
    await api.promptTask("ab", "hi");
    await api.respondPermission("ab", { requestId: "r", decision: "cancel" });
    await api.saveSettings({ defaultCwd: "/tmp" });
    expect(calls).toEqual([
      { method: "GET", path: "/api/tasks", body: undefined },
      { method: "POST", path: "/api/tasks/a%20b/cancel", body: {} },
      { method: "POST", path: "/api/tasks/ab/close", body: {} },
      { method: "POST", path: "/api/tasks/ab/prompt", body: { text: "hi" } },
      {
        method: "POST",
        path: "/api/tasks/ab/permission",
        body: { requestId: "r", decision: "cancel" },
      },
      { method: "PUT", path: "/api/settings", body: { defaultCwd: "/tmp" } },
    ]);
  });

  it("surfaces server errors", async () => {
    installFetch(() => ({ status: 400, body: { error: "bad input" } }));
    await expect(api.createTask({ cwd: "/tmp", yolo: false })).rejects.toThrow("bad input");
  });
});
