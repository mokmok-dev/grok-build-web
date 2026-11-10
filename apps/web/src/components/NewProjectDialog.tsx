import { useEffect, useState } from "react";
import { basename, fetchDirs, type DirectoryListing, type ProjectInput } from "../api.ts";
import { Dialog } from "./Dialog.tsx";

const DirRow = ({
  path,
  selected,
  onSelect,
  startOpen = false,
}: {
  readonly path: string | null;
  readonly selected: string | null;
  readonly onSelect: (path: string) => void;
  readonly startOpen?: boolean;
}) => {
  const [expanded, setExpanded] = useState(startOpen);
  const [listing, setListing] = useState<DirectoryListing | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!expanded || listing !== undefined) return;
    let live = true;
    setError(undefined);
    fetchDirs(path)
      .then((next) => {
        if (live) setListing(next);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [expanded, listing, path]);

  // A null path asks the server for its default cwd, so the row has no name until the listing lands.
  const resolved = path ?? listing?.path ?? null;
  if (resolved === null) {
    return (
      <li>
        {error === undefined ? (
          <p className="empty-note">Loading…</p>
        ) : (
          <p className="error" role="status">
            {error}
          </p>
        )}
      </li>
    );
  }

  const label = basename(resolved);
  return (
    <li>
      <div className="dir-row">
        <button
          type="button"
          className="dir-toggle"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <button
          type="button"
          className={selected === resolved ? "dir-name selected" : "dir-name"}
          aria-pressed={selected === resolved}
          title={resolved}
          onClick={() => onSelect(resolved)}
        >
          {label}
        </button>
      </div>
      {expanded && error !== undefined ? (
        <p className="error" role="status">
          {error}
        </p>
      ) : null}
      {expanded && listing !== undefined ? (
        <ul className="dir-children">
          {listing.entries.length === 0 ? <li className="empty-note">No subdirectories</li> : null}
          {listing.entries.map((entry) => (
            <DirRow key={entry} path={entry} selected={selected} onSelect={onSelect} />
          ))}
          {listing.truncated === true ? (
            <li className="empty-note">
              Showing the first {listing.entries.length} subdirectories
            </li>
          ) : null}
        </ul>
      ) : null}
      {expanded && listing === undefined && error === undefined ? (
        <p className="empty-note">Loading…</p>
      ) : null}
    </li>
  );
};

export const NewProjectDialog = ({
  defaultCwd,
  roots,
  onClose,
  onCreate,
}: {
  readonly defaultCwd: string | null;
  readonly roots: readonly string[];
  readonly onClose: () => void;
  readonly onCreate: (input: ProjectInput) => Promise<void>;
}) => {
  const [root, setRoot] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const anchors: readonly (string | null)[] = roots.length === 0 ? [defaultCwd] : roots;

  return (
    <Dialog title="New project" onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (root === null || submitting) return;
          const trimmed = name.trim();
          setSubmitError(undefined);
          setSubmitting(true);
          onCreate({ name: trimmed === "" ? undefined : trimmed, root })
            .catch((cause: unknown) =>
              setSubmitError(cause instanceof Error ? cause.message : String(cause)),
            )
            .finally(() => setSubmitting(false));
        }}
      >
        <label htmlFor="new-project-name">Project name</label>
        <input
          id="new-project-name"
          value={name}
          placeholder={basename(root ?? defaultCwd ?? "")}
          onChange={(event) => setName(event.target.value)}
        />

        <div role="group" aria-label="Project root">
          <p className="dir-label">Project root</p>
          <ul className="dir-tree">
            {anchors.map((anchor) => (
              <DirRow
                key={anchor ?? "default"}
                path={anchor}
                selected={root}
                onSelect={setRoot}
                startOpen
              />
            ))}
          </ul>
        </div>

        <p className="empty-note" aria-live="polite">
          {root === null ? "Select a directory" : `Selected: ${root}`}
        </p>

        {submitError === undefined ? null : (
          <p className="error" role="status">
            {submitError}
          </p>
        )}

        <div className="form-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={root === null || submitting}>
            Create project
          </button>
        </div>
      </form>
    </Dialog>
  );
};
