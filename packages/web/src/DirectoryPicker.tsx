import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getDirectories } from "./api";

function message(error: unknown) {
  return error instanceof Error ? error.message : "The folder could not be opened.";
}

/**
 * Server-backed folder browser. A browser cannot hand a native dialog's absolute path to the
 * server, so this walks the filesystem through the Argus API and returns a real directory path.
 */
export function DirectoryPicker({ open, initial, onClose, onSelect }: {
  open: boolean;
  initial?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const [path, setPath] = useState<string | undefined>(initial);
  const [draft, setDraft] = useState(initial ?? "");
  const listing = useQuery({
    queryKey: ["directories", path ?? ""],
    queryFn: () => getDirectories(path),
    enabled: open,
    retry: false,
  });

  useEffect(() => {
    if (open) {
      setPath(initial);
      setDraft(initial ?? "");
    }
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, onClose]);

  useEffect(() => {
    if (listing.data) setDraft(listing.data.path);
  }, [listing.data]);

  if (!open) return null;

  const data = listing.data;
  const current = data?.path ?? draft;
  const go = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setPath(draft.trim() || undefined);
  };

  return <div className="scrim" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target) onClose();
  }}>
    <section className="dialog" role="dialog" aria-modal="true" aria-label="Choose a working directory">
      <header className="dialog-head">
        <div>
          <h2>Choose a working directory</h2>
          <p>Pick an existing folder with the files the agents should work on.</p>
        </div>
        <button type="button" className="quiet" onClick={onClose}>Close</button>
      </header>

      <div className="dialog-body">
        <div className="dirbar">
          <button type="button" disabled={!data?.parent} onClick={() => { if (data?.parent) setPath(data.parent); }}>
            Up
          </button>
          <form onSubmit={go}>
            <input value={draft} spellCheck={false} aria-label="Path"
              onChange={(event) => setDraft(event.target.value)} placeholder="Type or paste a path, then press Enter" />
          </form>
          <button type="button" className="primary" onClick={go} disabled={draft.trim() === current}>Open</button>
        </div>

        {data && data.roots.length > 1 && <div className="dir-roots" role="group" aria-label="Drives">
          {data.roots.map((root) => <button type="button" key={root} aria-pressed={current === root}
            onClick={() => setPath(root)}>{root}</button>)}
        </div>}

        {listing.isLoading && <p className="faint" style={{ fontSize: 13.5 }}>Reading folder…</p>}
        {listing.error && <p className="problem" role="alert">{message(listing.error)}</p>}
        {data?.error && <p className="problem" role="alert">{data.error}</p>}

        {data && !data.error && <div className="dir-list">
          {data.directories.map((dir) => <button type="button" key={dir.path} onClick={() => setPath(dir.path)}>
            <span className="dir-name">{dir.name}</span>
          </button>)}
          {data.directories.length === 0 && <p className="faint" style={{ fontSize: 13.5, padding: "10px 10px" }}>
            No subfolders here. You can still use this folder.
          </p>}
        </div>}
      </div>

      <footer className="dialog-foot">
        <span className={`grow mono ${data?.error ? "faint" : ""}`} title={current}>{current || "No folder chosen"}</span>
        <div className="dialog-foot-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="button" disabled={!data || Boolean(data.error)}
            onClick={() => { if (data) { onSelect(data.path); onClose(); } }}>
            Use this folder
          </button>
        </div>
      </footer>
    </section>
  </div>;
}
