import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const chat = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => undefined),
  onFinish: undefined as (() => void) | undefined,
  error: undefined as Error | undefined,
  isLoading: false,
}));

vi.mock("@tanstack/ai-react", () => ({
  fetchServerSentEvents: (url: string) => ({ url }),
  useChat: (options: { onFinish?: () => void }) => {
    chat.onFinish = options.onFinish;
    return {
      messages: [],
      sendMessage: chat.sendMessage,
      error: chat.error,
      isLoading: chat.isLoading,
    };
  },
}));

const calls: Call[] = [];

class FakeEventSource {
  static readonly instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {
    // no-op
  }
  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }
}

const waitForCall = async (method: string, path: string): Promise<void> => {
  const started = Date.now();
  while (!calls.some((call) => call.method === method && call.path === path)) {
    if (Date.now() - started > 2_000) throw new Error(`no ${method} ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

type RouteResult = { readonly status?: number; readonly body: unknown };

const installFetch = (
  handler: (call: Call) => RouteResult | undefined | Promise<RouteResult | undefined>,
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
      const result = await handler(call);
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

const runningRoutes = (call: Call): { status?: number; body: unknown } | undefined => {
  if (call.path === "/api/tasks" && call.method === "GET") {
    return { body: { tasks: [{ ...summary, status: "running" }] } };
  }
  return baseRoutes(call);
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
          configFile: "/tmp/grok-build-web.config.json",
          configFileExists: true,
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
    case "/api/projects":
      return { body: { projects: [] } };
    case "/api/tasks/s1":
      return { body: detail() };
    default:
      return undefined;
  }
};

const alphaProjectRoutes = (call: Call): { status?: number; body: unknown } | undefined => {
  if (call.path === "/api/tasks" && call.method === "GET") {
    return {
      body: { tasks: [{ ...summary, id: "a", title: "Alpha task", cwd: "/tmp/alpha/src" }] },
    };
  }
  if (call.path === "/api/projects" && call.method === "GET") {
    return { body: { projects: [{ id: "p1", name: "Alpha", root: "/tmp/alpha" }] } };
  }
  if (call.path === "/api/tasks" && call.method === "POST") {
    return { body: detail({ id: "s2", title: "Fresh", cwd: "/tmp/alpha/src" }) };
  }
  if (call.path === "/api/tasks/s2") return { body: detail({ id: "s2", title: "Fresh" }) };
  return baseRoutes(call);
};

beforeEach(() => {
  chat.sendMessage.mockClear();
  chat.sendMessage.mockImplementation(async () => undefined);
  chat.error = undefined;
  chat.isLoading = false;
  chat.onFinish = undefined;
});

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
      if (call.path === "/api/projects" && call.method === "GET") {
        return {
          body: {
            projects: [{ id: "p1", name: "Sub", root: "/tmp/work/sub" }],
          },
        };
      }
      return baseRoutes(call);
    });
    render(<App />);
    await screen.findByText("My task");
    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.selectOptions(screen.getByLabelText("Project"), "/tmp/work/sub");
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

  it("leaves the cwd out of the body when the default working directory is chosen", async () => {
    const user = userEvent.setup();
    installFetch((call) => {
      if (call.path === "/api/tasks" && call.method === "POST") {
        return { body: detail({ id: "s2", title: "Fresh" }) };
      }
      if (call.path === "/api/tasks/s2") return { body: detail({ id: "s2", title: "Fresh" }) };
      return baseRoutes(call);
    });
    render(<App />);
    await screen.findByText("My task");
    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() =>
      expect(
        calls.find((call) => call.method === "POST" && call.path === "/api/tasks"),
      ).toBeTruthy(),
    );
    expect(
      calls.find((call) => call.method === "POST" && call.path === "/api/tasks")?.body,
    ).toEqual({ yolo: false });
  });

  it("expands the project that holds a task created from the dialog", async () => {
    const user = userEvent.setup();
    installFetch(alphaProjectRoutes);
    render(<App />);
    const header = await screen.findByRole("button", { name: /^Alpha,/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Alpha task")).toBeNull();

    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.selectOptions(screen.getByLabelText("Project"), "/tmp/alpha");
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await screen.findByRole("heading", { name: "Fresh" });
    expect(screen.getByRole("button", { name: /^Alpha,/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(screen.getByText("Alpha task")).toBeTruthy();
    expect(screen.getByText("alpha · 2 tasks")).toBeTruthy();
  });

  it("expands a manually collapsed project when a task is created in it", async () => {
    const user = userEvent.setup();
    installFetch(alphaProjectRoutes);
    render(<App />);
    const header = await screen.findByRole("button", { name: /^Alpha,/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    await user.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    await user.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");

    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.selectOptions(screen.getByLabelText("Project"), "/tmp/alpha");
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await screen.findByRole("heading", { name: "Fresh" });
    expect(screen.getByRole("button", { name: /^Alpha,/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(screen.getByText("Alpha task")).toBeTruthy();
  });

  it("cancels a running task, refreshes and closes it", async () => {
    const user = userEvent.setup();
    installFetch((call) => {
      if (call.path === "/api/tasks/s1") return { body: detail({ status: "running" }) };
      if (call.path === "/api/tasks/s1/cancel") return { body: { accepted: true } };
      if (call.path === "/api/tasks/s1/close") return { body: { closed: true } };
      return runningRoutes(call);
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /My task/ }));
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
    await user.click(cancel);
    expect(
      calls.some((call) => call.method === "POST" && call.path === "/api/tasks/s1/cancel"),
    ).toBe(true);

    calls.splice(0);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitForCall("GET", "/api/tasks");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitForCall("POST", "/api/tasks/s1/close");
  });

  it("applies task list updates from the event stream", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.instances.splice(0);
    installFetch(baseRoutes);
    render(<App />);
    expect(await screen.findByText("My task")).toBeTruthy();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("no EventSource");
    act(() => {
      source.emit({ type: "tasks", tasks: [{ ...summary, id: "s2", title: "Live task" }] });
    });
    expect(await screen.findByText("Live task")).toBeTruthy();
  });

  it("polls the detail while the selected task runs", async () => {
    vi.useFakeTimers();
    FakeEventSource.instances.splice(0);
    try {
      let detailCalls = 0;
      installFetch((call) => {
        if (call.path === "/api/tasks/s1") {
          detailCalls += 1;
          return { body: detail({ status: "running" }) };
        }
        return runningRoutes(call);
      });
      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: /My task/ }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      const first = detailCalls;
      expect(first).toBeGreaterThan(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
      });
      expect(detailCalls).toBeGreaterThan(first);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
      });
      expect(detailCalls).toBeGreaterThan(first + 1);
    } finally {
      vi.useRealTimers();
    }
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

  it("shows the settings read-only", async () => {
    const user = userEvent.setup();
    installFetch(baseRoutes);
    render(<App />);
    await screen.findByText("My task");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getByText("/tmp/grok-build-web.config.json")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("sends composer text through useChat and refetches on finish", async () => {
    const user = userEvent.setup();
    installFetch((call) => {
      if (call.path === "/api/tasks/s1") return { body: detail() };
      if (call.path === "/api/tasks" && call.method === "GET") {
        return { body: { tasks: [summary] } };
      }
      return baseRoutes(call);
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /My task/ }));
    await screen.findByLabelText("Message");
    await user.type(screen.getByLabelText("Message"), "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(chat.sendMessage).toHaveBeenCalledWith("hello");

    calls.splice(0);
    if (chat.onFinish === undefined) throw new Error("chat did not expose onFinish");
    act(() => {
      chat.onFinish?.();
    });
    await waitForCall("GET", "/api/tasks/s1");
  });

  it("renders a chat error", async () => {
    const user = userEvent.setup();
    chat.error = new Error("stream broke");
    installFetch(baseRoutes);
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /My task/ }));
    expect(await screen.findByText("stream broke")).toBeTruthy();
  });

  it("surfaces a failed detail load and a failed health probe", async () => {
    const user = userEvent.setup();
    installFetch((call) => {
      if (call.path === "/api/health") throw new Error("health down");
      if (call.path === "/api/tasks/s1") return { status: 500, body: { error: "detail failed" } };
      return baseRoutes(call);
    });
    render(<App />);
    expect(await screen.findByText("Disconnected")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: /My task/ }));
    expect(await screen.findByText("detail failed")).toBeTruthy();
  });

  it("ignores a stale detail response after the selection moved on", async () => {
    const user = userEvent.setup();
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    installFetch(async (call) => {
      if (call.path === "/api/tasks") {
        return { body: { tasks: [summary, { ...summary, id: "s2", title: "Second" }] } };
      }
      if (call.path === "/api/tasks/s1") {
        await gate;
        return {
          body: detail({
            title: "Old",
            messages: [
              {
                id: "u1",
                role: "user",
                createdAt: 1,
                parts: [{ type: "text", text: "stale transcript" }],
              },
            ],
          }),
        };
      }
      if (call.path === "/api/tasks/s2") {
        return {
          body: detail({
            id: "s2",
            title: "Second",
            messages: [
              {
                id: "u2",
                role: "user",
                createdAt: 1,
                parts: [{ type: "text", text: "second transcript" }],
              },
            ],
          }),
        };
      }
      return baseRoutes(call);
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /My task/ }));
    await user.click(screen.getByRole("button", { name: /Second/ }));
    expect(await screen.findByRole("heading", { name: "Second" })).toBeTruthy();
    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByRole("heading", { name: "Second" })).toBeTruthy();
    expect(screen.getByText("second transcript")).toBeTruthy();
    expect(screen.queryByText("stale transcript")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Old" })).toBeNull();
  });

  it("moves focus into the drawer and back on mobile", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      media: "",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    installFetch(baseRoutes);
    render(<App />);
    await screen.findByText("My task");
    const menu = screen.getByRole("button", { name: "Open task list" });
    fireEvent.click(menu);
    const sidebar = screen.getByRole("complementary", { name: "Tasks" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.activeElement).toBe(sidebar);
    fireEvent.click(screen.getByRole("button", { name: "Close task list" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.activeElement).toBe(menu);
  });

  it("shows an error when the task list fails to load", async () => {
    installFetch((call) => {
      if (call.path === "/api/tasks" && call.method === "GET") {
        return { status: 500, body: { error: "list failed" } };
      }
      return baseRoutes(call);
    });
    render(<App />);
    expect(await screen.findByText("list failed")).toBeTruthy();
  });

  it("falls back when settings and agent fetches fail", async () => {
    const user = userEvent.setup();
    installFetch((call) => {
      if (call.path === "/api/settings" || call.path === "/api/agent") {
        throw new Error("unavailable");
      }
      return baseRoutes(call);
    });
    render(<App />);
    await screen.findByText("My task");
    await user.click(screen.getByRole("button", { name: "New task" }));
    const project = (await screen.findByLabelText("Project")) as HTMLSelectElement;
    expect(project.value).toBe("");
    const options = within(project).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toBe("Default working directory");
    const models = within(screen.getByLabelText("Model")).getAllByRole("option");
    expect(models).toHaveLength(1);
    expect(models[0]?.textContent).toBe("Default");
  });

  it("reports a failed permission submit", async () => {
    const user = userEvent.setup();
    installFetch((call) => {
      if (call.path === "/api/tasks/s1") {
        return {
          body: detail({
            pendingPermission: {
              requestId: "r1",
              toolCallId: "t1",
              title: "Run ls",
              options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
            },
          }),
        };
      }
      if (call.path === "/api/tasks/s1/permission") {
        return { status: 400, body: { error: "permission rejected" } };
      }
      return baseRoutes(call);
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /My task/ }));
    await user.click(await screen.findByRole("button", { name: "Allow once" }));
    expect(await screen.findByText("permission rejected")).toBeTruthy();
  });

  it("closes the new-task dialog", async () => {
    const user = userEvent.setup();
    installFetch(baseRoutes);
    render(<App />);
    await screen.findByText("My task");
    await user.click(screen.getByRole("button", { name: "New task" }));
    expect(await screen.findByRole("dialog", { name: "New task" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull();
  });

  it("creates a project from the picker and expands it in the sidebar", async () => {
    const user = userEvent.setup();
    installFetch((call) => {
      if (call.path === "/api/projects" && call.method === "POST") {
        return { body: { id: "p1", name: "Alpha", root: "/tmp/work/app" } };
      }
      if (call.path.startsWith("/api/fs/dirs")) {
        return {
          body: {
            path: "/tmp/work",
            entries: ["/tmp/work/app"],
          },
        };
      }
      return baseRoutes(call);
    });
    render(<App />);
    await screen.findByText("My task");
    const newProject = screen.getByRole("button", { name: "New project" }) as HTMLButtonElement;
    await waitFor(() => expect(newProject.disabled).toBe(false));

    await user.click(newProject);
    expect(await screen.findByRole("dialog", { name: "New project" })).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "app" }));
    await user.click(screen.getByRole("button", { name: "Create project" }));

    expect(
      calls.find((call) => call.method === "POST" && call.path === "/api/projects")?.body,
    ).toEqual({ name: undefined, root: "/tmp/work/app" });
    const header = await screen.findByRole("button", { name: /Alpha/ });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("app · 0 tasks")).toBeTruthy();
  });

  it("keeps the project dialog open when creation is rejected", async () => {
    const user = userEvent.setup();
    installFetch((call) => {
      if (call.path === "/api/projects" && call.method === "POST") {
        return {
          status: 400,
          body: { error: "A project already uses this directory: /tmp/work/app" },
        };
      }
      if (call.path.startsWith("/api/fs/dirs")) {
        return {
          body: {
            path: "/tmp/work",
            entries: ["/tmp/work/app"],
          },
        };
      }
      return baseRoutes(call);
    });
    render(<App />);
    await screen.findByText("My task");
    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(await screen.findByRole("button", { name: "app" }));
    await user.click(screen.getByRole("button", { name: "Create project" }));
    expect(
      await screen.findByText("A project already uses this directory: /tmp/work/app"),
    ).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "New project" })).toBeTruthy();
    expect(screen.getByText("Selected: /tmp/work/app")).toBeTruthy();
  });

  it("opens the project picker without settings", async () => {
    const user = userEvent.setup();
    installFetch((call) => {
      if (call.path === "/api/settings") throw new Error("unavailable");
      if (call.path === "/api/fs/dirs") {
        return { body: { path: "/srv", entries: [] } };
      }
      return baseRoutes(call);
    });
    render(<App />);
    await screen.findByText("My task");
    const newProject = screen.getByRole("button", { name: "New project" }) as HTMLButtonElement;
    await waitFor(() => expect(newProject.disabled).toBe(false));
    await user.click(newProject);
    expect(await screen.findByRole("dialog", { name: "New project" })).toBeTruthy();
    expect(calls.some((call) => call.path === "/api/fs/dirs")).toBe(true);
  });

  it("reports a failed project list load", async () => {
    installFetch((call) => {
      if (call.path === "/api/projects" && call.method === "GET") {
        return { status: 500, body: { error: "projects failed" } };
      }
      return baseRoutes(call);
    });
    render(<App />);
    expect(await screen.findByText("projects failed")).toBeTruthy();
    expect(await screen.findByText("My task")).toBeTruthy();
  });

  it("polls health on the timer", async () => {
    vi.useFakeTimers();
    try {
      installFetch(baseRoutes);
      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      const healthCalls = (): number => calls.filter((call) => call.path === "/api/health").length;
      expect(healthCalls()).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      expect(healthCalls()).toBe(2);
      // The 30 s clock interval also fires here; coverage is the assertion that polling continues.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(healthCalls()).toBeGreaterThanOrEqual(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders no permission banner for a task without a pending permission", async () => {
    const user = userEvent.setup();
    installFetch(baseRoutes);
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /My task/ }));
    await screen.findByRole("heading", { name: "My task" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens settings from the disconnected empty state", async () => {
    const user = userEvent.setup();
    installFetch((call) =>
      call.path === "/api/health"
        ? { body: { ok: true, acp: { connected: false } } }
        : baseRoutes(call),
    );
    render(<App />);
    expect(await screen.findByText("Not connected to the agent")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeTruthy();
  });

  it("closes the settings dialog", async () => {
    const user = userEvent.setup();
    installFetch(baseRoutes);
    render(<App />);
    await screen.findByText("My task");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("keeps the new-task dialog open with its prompt when creation is rejected", async () => {
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
    await user.type(screen.getByLabelText("First prompt"), "keep me");
    await user.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByText("Working directory is outside the allowed roots")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "New task" })).toBeTruthy();
    expect((screen.getByLabelText("First prompt") as HTMLTextAreaElement).value).toBe("keep me");
  });
});

describe("api wrappers", () => {
  it("sends the documented method, path and body", async () => {
    installFetch((call) => ({ body: call.method === "GET" ? { tasks: [] } : {} }));
    await api.fetchTasks();
    await api.cancelTask("a b");
    await api.closeTask("ab");
    await api.respondPermission("ab", { requestId: "r", decision: "cancel" });
    expect(calls).toEqual([
      { method: "GET", path: "/api/tasks", body: undefined },
      { method: "POST", path: "/api/tasks/a%20b/cancel", body: {} },
      { method: "POST", path: "/api/tasks/ab/close", body: {} },
      {
        method: "POST",
        path: "/api/tasks/ab/permission",
        body: { requestId: "r", decision: "cancel" },
      },
    ]);
  });

  it("surfaces server errors", async () => {
    installFetch(() => ({ status: 400, body: { error: "bad input" } }));
    await expect(api.createTask({ cwd: "/tmp", yolo: false })).rejects.toThrow("bad input");
  });
});
