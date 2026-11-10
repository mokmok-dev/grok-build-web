import type { TaskSummary } from "@grok-build-web/task-model";
import { basename, isWithinRoot, type Project } from "../api.ts";
import { TaskList } from "./TaskList.tsx";

export const UNGROUPED = "ungrouped";

interface TaskGroup {
  readonly key: string;
  readonly name: string;
  readonly detail: string;
  readonly tasks: readonly TaskSummary[];
}

const countLabel = (count: number): string => `${count} ${count === 1 ? "task" : "tasks"}`;

export const projectFor = (projects: readonly Project[], cwd: string): Project | undefined =>
  projects
    .filter((project) => isWithinRoot(cwd, project.root))
    .sort((left, right) => right.root.length - left.root.length)[0];

export const ProjectList = ({
  projects,
  tasks,
  selectedId,
  now,
  expanded,
  onToggle,
  onSelect,
}: {
  readonly projects: readonly Project[];
  readonly tasks: readonly TaskSummary[];
  readonly selectedId: string | null;
  readonly now: number;
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly onToggle: (key: string, open: boolean) => void;
  readonly onSelect: (id: string) => void;
}) => {
  const groupOf = (task: TaskSummary): Project | undefined => projectFor(projects, task.cwd);
  const ungrouped = tasks.filter((task) => groupOf(task) === undefined);
  const groups: readonly TaskGroup[] = [
    ...projects.map((project) => {
      const owned = tasks.filter((task) => groupOf(task)?.id === project.id);
      return {
        key: project.id,
        name: project.name,
        detail: `${basename(project.root)} · ${countLabel(owned.length)}`,
        tasks: owned,
      };
    }),
    ...(ungrouped.length > 0 || projects.length === 0
      ? [
          {
            key: UNGROUPED,
            name: "Ungrouped",
            detail: countLabel(ungrouped.length),
            tasks: ungrouped,
          },
        ]
      : []),
  ];

  return (
    <div className="project-list">
      {groups.map((group) => {
        const selected = group.tasks.some((task) => task.id === selectedId);
        const open = expanded[group.key] ?? (selected || group.key === UNGROUPED);
        const listId = `project-tasks-${group.key}`;
        return (
          <section className="project" key={group.key}>
            <h2 className="project-heading">
              <button
                type="button"
                className="project-header"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                aria-label={`${group.name}, ${group.detail}`}
                onClick={() => onToggle(group.key, !open)}
              >
                <span className="project-chevron" aria-hidden="true">
                  {open ? "▾" : "▸"}
                </span>
                <span className="project-name">{group.name}</span>
                <span className="project-meta">{group.detail}</span>
              </button>
            </h2>
            {open ? (
              <div id={listId}>
                {group.tasks.length === 0 ? (
                  <p className="empty-note">
                    {group.key === UNGROUPED
                      ? "No tasks yet. Create one to start a session."
                      : "No tasks in this project."}
                  </p>
                ) : (
                  <TaskList
                    tasks={group.tasks}
                    selectedId={selectedId}
                    now={now}
                    onSelect={onSelect}
                  />
                )}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
};
