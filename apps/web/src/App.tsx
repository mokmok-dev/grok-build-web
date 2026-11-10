import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import type { TaskSummary } from "@grok-build-web/task-model";
import {
  cancelTask,
  closeTask,
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

type Connection = "connected" | "reconnecting" | "disconnected" | "not-configured";

const connectionOf = (settings: Settings | null, health: Health | null): Connection => {
  if (settings === null || !settings.hasSecret) return "not-configured";
  if (health === null) return "disconnected";
  if (health.acp.connected) return "connected";
  return health.acp.lastError === undefined ? "disconnected" : "reconnecting";
};

const connectionLabel: Record<Connection, string> = {
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  "not-configured": "Not configured",
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

  const selected = tasks.find((task) => task.id === selectedId);

  const reloadDetail = useCallback(async () => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await fetchTask(selectedId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [selectedId]);

  useEffect(() => {
    void reloadDetail();
  }, [reloadDetail]);

  const selectedUpdatedAt = selected?.updatedAt;
  useEffect(() => {
    if (selectedId !== null) void reloadDetail();
  }, [selectedUpdatedAt, selectedId, reloadDetail]);

  const connection = connectionOf(settings, health);
  const connected = connection === "connected";

  const handleCreate = (input: NewTaskInput): void => {
    setShowNewTask(false);
    createTask(input)
      .then((created) => {
        setSelectedId(created.id);
        setDetail(created);
        void reloadTasks();
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
      .then(() => reloadDetail())
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
        type="button"
        className="menu-button"
        aria-label="Open task list"
        onClick={() => setDrawerOpen(true)}
      >
        ☰
      </button>

      <aside className={drawerOpen ? "sidebar open" : "sidebar"} aria-label="Tasks">
        <div className="sidebar-header">
          <span className={`connection connection-${connection}`}>
            {connectionLabel[connection]}
          </span>
          <div className="sidebar-actions">
            <button
              type="button"
              onClick={() => setShowNewTask(true)}
              disabled={connection === "not-configured"}
            >
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
            title={connection === "not-configured" ? "ACP is not configured" : "No task selected"}
            body={
              connection === "not-configured"
                ? "Add the agent WebSocket URL and secret in Settings."
                : "Pick a task from the list or create a new one."
            }
            action={
              connection === "not-configured" ? (
                <button type="button" onClick={() => setShowSettings(true)}>
                  Open settings
                </button>
              ) : undefined
            }
          />
        ) : (
          <>
            <TaskHeader
              task={selected}
              connected={connected}
              onCancel={() => {
                void cancelTask(selected.id).then(() => reloadDetail());
              }}
              onClose={() => {
                void closeTask(selected.id).then(() => reloadTasks());
              }}
              onRefresh={() => {
                void reloadDetail();
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
                onTurnFinished={reloadDetail}
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
