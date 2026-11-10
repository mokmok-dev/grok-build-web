import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import type { TaskSummary } from "@grok-build-web/task-model";
import {
  cancelTask,
  closeTask,
  CONNECTION_LABELS,
  connectionOf,
  createTask,
  fetchAgent,
  fetchHealth,
  fetchSettings,
  fetchTask,
  fetchTasks,
  respondPermission,
  saveSettings,
  toInitialMessages,
  type AgentInfo,
  type Health,
  type Settings,
  type TaskDetail,
} from "./api.ts";
import { Composer } from "./components/Composer.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { NewTaskDialog, type NewTaskInput } from "./components/NewTaskDialog.tsx";
import { PermissionBanner, type PermissionDecision } from "./components/PermissionBanner.tsx";
import { SettingsDialog, type SettingsInput } from "./components/SettingsDialog.tsx";
import { TaskHeader } from "./components/TaskHeader.tsx";
import { TaskList } from "./components/TaskList.tsx";
import { Transcript } from "./components/Transcript.tsx";

const useMobile = (): boolean => {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 800px)");
    const update = (): void => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
};

const ChatPanel = ({
  detail,
  connected,
  onTurnFinished,
}: {
  readonly detail: TaskDetail;
  readonly connected: boolean;
  readonly onTurnFinished: () => void;
}) => {
  const connection = useMemo(
    () => fetchServerSentEvents(`/api/tasks/${encodeURIComponent(detail.id)}/chat`),
    [detail.id],
  );
  const initialMessages = useMemo(() => toInitialMessages(detail), [detail.id]);
  const chat = useChat({
    connection,
    threadId: detail.id,
    initialMessages,
    onFinish: () => {
      onTurnFinished();
    },
  });

  // While a turn streams, the hook holds the live transcript; otherwise the server is the source of truth.
  const messages = chat.isLoading ? chat.messages : toInitialMessages(detail);

  return (
    <>
      <Transcript
        messages={messages}
        plan={detail.plan}
        usage={detail.usage}
        streaming={chat.isLoading}
      />
      {chat.error === undefined ? null : (
        <p className="error" role="status">
          {chat.error.message}
        </p>
      )}
      <Composer
        disabled={!connected || detail.status === "closed"}
        placeholder={connected ? "Ask Grok… (Ctrl/Cmd + Enter)" : "Disconnected"}
        onSend={(text) => {
          void chat.sendMessage(text).then(() => onTurnFinished());
        }}
      />
    </>
  );
};

export const App = () => {
  const [tasks, setTasks] = useState<readonly TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<Health | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mobile = useMobile();

  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const loadedIdRef = useRef<string | null>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mountedRef = useRef(false);

  const reloadTasks = useCallback(async () => {
    try {
      setTasks(await fetchTasks());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadHealth = useCallback(async () => {
    try {
      setHealth(await fetchHealth());
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    void reloadTasks();
    void reloadHealth();
    fetchSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
    fetchAgent()
      .then(setAgent)
      .catch(() => setAgent(null));

    const clock = setInterval(() => setNow(Date.now()), 30_000);
    const poll = setInterval(() => {
      void reloadHealth();
    }, 5_000);
    const source = typeof EventSource === "undefined" ? null : new EventSource("/api/events");
    if (source !== null) {
      source.onmessage = (event: MessageEvent<string>) => {
        const payload = JSON.parse(event.data) as { type: string; tasks?: TaskSummary[] };
        if (payload.type === "tasks" && payload.tasks !== undefined) {
          setTasks(payload.tasks);
          setLoading(false);
        }
      };
    }
    return () => {
      clearInterval(clock);
      clearInterval(poll);
      source?.close();
    };
  }, [reloadTasks, reloadHealth]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const next = await fetchTask(id);
      if (selectedIdRef.current === id) setDetail(next);
    } catch (cause) {
      if (selectedIdRef.current === id) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, []);

  const selected = tasks.find((task) => task.id === selectedId);
  const selectedUpdatedAt = selected?.updatedAt;

  // One detail effect: reset on selection change, coalesce refetches triggered by list updates.
  useEffect(() => {
    if (selectedId === null) {
      loadedIdRef.current = null;
      setDetail(null);
      return;
    }
    if (loadedIdRef.current !== selectedId) {
      loadedIdRef.current = selectedId;
      setDetail(null);
    }
    const timer = setTimeout(() => {
      void loadDetail(selectedId);
    }, 150);
    return () => clearTimeout(timer);
  }, [selectedId, selectedUpdatedAt, loadDetail]);

  // Turns driven outside useChat only publish a few list snapshots, so poll the open task while it runs.
  const running = selected?.status === "running";
  useEffect(() => {
    if (!running || selectedId === null) return;
    const timer = setInterval(() => {
      void loadDetail(selectedId);
    }, 1_000);
    return () => clearInterval(timer);
  }, [running, selectedId, loadDetail]);

  useEffect(() => {
    if (!mobile) return;
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (drawerOpen) sidebarRef.current?.focus();
    else menuRef.current?.focus();
  }, [drawerOpen, mobile]);

  const connection = connectionOf(health);
  const connected = connection === "connected";

  const handleCreate = (input: NewTaskInput): void => {
    setShowNewTask(false);
    createTask(input)
      .then((created) => {
        setTasks((current) => [created, ...current.filter((task) => task.id !== created.id)]);
        setSelectedId(created.id);
        setDetail(created);
        loadedIdRef.current = created.id;
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const handlePermission = (decision: PermissionDecision): void => {
    const pending = detail?.pendingPermission;
    if (selectedId === null || pending === undefined) return;
    const body =
      decision === "cancel"
        ? { requestId: pending.requestId, decision }
        : { requestId: pending.requestId, optionId: decision.optionId };
    respondPermission(selectedId, body)
      .then(() => loadDetail(selectedId))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const handleSaveSettings = (input: SettingsInput): void => {
    saveSettings(input)
      .then((next) => {
        setSettings(next);
        setShowSettings(false);
        void reloadHealth();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <div className="app">
      <button
        ref={menuRef}
        type="button"
        className="menu-button"
        aria-label="Open task list"
        aria-expanded={drawerOpen}
        aria-controls="task-sidebar"
        onClick={() => setDrawerOpen(true)}
      >
        ☰
      </button>

      <aside
        id="task-sidebar"
        ref={sidebarRef}
        className={drawerOpen ? "sidebar open" : "sidebar"}
        aria-label="Tasks"
        tabIndex={-1}
        inert={mobile && !drawerOpen}
      >
        <div className="sidebar-header">
          <span className={`connection connection-${connection}`}>
            {CONNECTION_LABELS[connection]}
          </span>
          {settings !== null && !settings.hasSecret ? (
            <span className="connection-hint">No ACP secret configured</span>
          ) : null}
          <div className="sidebar-actions">
            <button type="button" onClick={() => setShowNewTask(true)} disabled={!connected}>
              New task
            </button>
            <button type="button" onClick={() => setShowSettings(true)}>
              Settings
            </button>
          </div>
        </div>
        {loading ? (
          <p className="empty-note">Loading tasks…</p>
        ) : (
          <TaskList
            tasks={tasks}
            selectedId={selectedId}
            now={now}
            onSelect={(id) => {
              setSelectedId(id);
              setDrawerOpen(false);
            }}
          />
        )}
      </aside>

      {drawerOpen ? (
        <button
          type="button"
          className="scrim"
          aria-label="Close task list"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      <main className="main">
        {selected === undefined ? (
          <EmptyState
            title={connected ? "No task selected" : "Not connected to the agent"}
            body={
              connected
                ? "Pick a task from the list or create a new one."
                : "Start grok agent serve, or check the URL and secret in Settings."
            }
            action={
              <button type="button" onClick={() => setShowSettings(true)}>
                Open settings
              </button>
            }
          />
        ) : (
          <>
            <TaskHeader
              task={selected}
              connected={connected}
              onCancel={() => {
                void cancelTask(selected.id).then(() => loadDetail(selected.id));
              }}
              onClose={() => {
                void closeTask(selected.id).then(() => reloadTasks());
              }}
              onRefresh={() => {
                void loadDetail(selected.id);
                void reloadTasks();
              }}
            />
            {detail?.pendingPermission === undefined ? null : (
              <PermissionBanner
                permission={detail.pendingPermission}
                disabled={!connected}
                onDecide={handlePermission}
              />
            )}
            {detail === null ? (
              <p className="empty-note">Loading task…</p>
            ) : (
              <ChatPanel
                key={detail.id}
                detail={detail}
                connected={connected}
                onTurnFinished={() => loadDetail(detail.id)}
              />
            )}
          </>
        )}
        {error === null ? null : (
          <p className="error" role="status">
            {error}
          </p>
        )}
      </main>

      {showNewTask ? (
        <NewTaskDialog
          defaultCwd={settings?.defaultCwd ?? ""}
          models={agent?.models.availableModels ?? []}
          onClose={() => setShowNewTask(false)}
          onCreate={handleCreate}
        />
      ) : null}

      {showSettings && settings !== null ? (
        <SettingsDialog
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSave={handleSaveSettings}
        />
      ) : null}
    </div>
  );
};
