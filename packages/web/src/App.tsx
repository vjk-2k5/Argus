import { FormEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Frame } from "@argus/shared";
import {
  approveFrame,
  cancelSession,
  createSession,
  deleteSession,
  getProviders,
  getSession,
  getSessions,
  pauseSession,
  resumeSession,
  startSession,
  updateFrame,
} from "./api";
import { useSessionEvents } from "./hooks";
import { ProviderSettings } from "./ProviderSettings";
import { ModelPicker } from "./ModelPicker";
import { Markdown } from "./Markdown";
import type {
  FrameView,
  MessageView,
  RoleModel,
  SessionDetailView,
} from "./types";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

function model(providerID = "", modelID = ""): RoleModel {
  return { providerID: providerID as RoleModel["providerID"], modelID, options: {} };
}

function NewSession({ onCreated }: { onCreated: (id: string) => void }) {
  const providers = useQuery({ queryKey: ["providers"], queryFn: getProviders });
  const [problem, setProblem] = useState("");
  const [maxRounds, setMaxRounds] = useState(6);
  const [framer, setFramer] = useState<RoleModel>(model());
  const [answerer, setAnswerer] = useState<RoleModel>(model());
  const [observer, setObserver] = useState<RoleModel>(model());
  const [providersOpen, setProvidersOpen] = useState(false);
  const [customModels, setCustomModels] = useState(false);
  const setAllModels = (value: RoleModel) => {
    setFramer(value);
    setAnswerer(value);
    setObserver(value);
  };

  useEffect(() => {
    if (!providers.data) return;
    setFramer((value) => value.modelID ? value : providers.data.defaults.framer);
    setAnswerer((value) => value.modelID ? value : providers.data.defaults.answerer);
    setObserver((value) => value.modelID ? value : providers.data.defaults.observer);
  }, [providers.data]);

  const create = useMutation({
    mutationFn: createSession,
    onSuccess: (session) => onCreated(session.id),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ problem, maxRounds, roles: { framer, answerer, observer } });
  };

  return (
    <section className="panel setup stack">
      <div><h2>New adversarial exploration</h2>
        <p className="muted">The Task Framer will first turn the problem into an approvable, bounded research task.</p>
      </div>
      <ProviderSettings open={providersOpen} onClose={() => setProvidersOpen(false)} />
      <form className="stack" onSubmit={submit}>
        <label>Problem
          <textarea value={problem} onChange={(event) => setProblem(event.target.value)}
            placeholder="Enter an open mathematical problem, research question, or organizational decision..." required />
        </label>
        <label>Maximum debate rounds
          <input type="number" min={1} value={maxRounds}
            onChange={(event) => setMaxRounds(Number(event.target.value))} required />
        </label>
        <div className="provider-strip">
          <div><strong>Providers</strong><small className="muted">{providers.data?.providers.filter((item) => item.configured).length ?? 0} connected</small></div>
          <button type="button" onClick={() => setProvidersOpen(true)}>Manage providers</button>
        </div>
        {providers.isLoading && <p className="muted">Loading providers…</p>}
        {providers.data && <section className="model-assignment">
          <div className="row spread"><div><strong>Agent models</strong><p className="muted">Use one model for every role, or customize individually.</p></div>
            <button type="button" onClick={() => setCustomModels((value) => !value)}>{customModels ? "Use one model" : "Customize roles"}</button></div>
          {!customModels
            ? <ModelPicker label="All agents" value={answerer} onChange={setAllModels} providers={providers.data.providers} />
            : <div className="role-models">
              <ModelPicker label="Task Framer" value={framer} onChange={setFramer} providers={providers.data.providers} />
              <ModelPicker label="Answer Agent" value={answerer} onChange={setAnswerer} providers={providers.data.providers} />
              <ModelPicker label="Observer / Questioner" value={observer} onChange={setObserver} providers={providers.data.providers} />
            </div>}
        </section>}
        {create.error && <p className="error">{errorText(create.error)}</p>}
        <button type="submit" disabled={create.isPending || !providers.data || !problem.trim()}>
          {create.isPending ? "Creating…" : "Frame problem"}
        </button>
      </form>
    </section>
  );
}
function lines(value: string) {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function ListField(props: { label: string; value: string[]; onChange: (value: string[]) => void }) {
  return <label>{props.label}<textarea className="short" value={props.value.join("\n")}
    onChange={(event) => props.onChange(lines(event.target.value))} /></label>;
}

function editable(frame: FrameView): Frame {
  const { approved: _approved, ...value } = frame;
  return value;
}

function FrameEditor({ session }: { session: SessionDetailView }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(session.frame!);
  useEffect(() => setDraft(session.frame!), [session.frame]);
  const done = (value: SessionDetailView) => {
    client.setQueryData(["session", session.id], value);
    void client.invalidateQueries({ queryKey: ["sessions"] });
  };
  const save = useMutation({ mutationFn: () => updateFrame(session.id, editable(draft)), onSuccess: done });
  const approve = useMutation({
    mutationFn: async () => {
      await updateFrame(session.id, editable(draft));
      return approveFrame(session.id);
    },
    onSuccess: done,
  });
  const busy = save.isPending || approve.isPending;
  const set = <K extends keyof FrameView>(key: K, value: FrameView[K]) => setDraft((old) => ({ ...old, [key]: value }));

  return <section className="panel stack">
    <div className="row spread"><div><h2>Task frame</h2><p className="muted">Review and edit before allowing the autonomous debate to start.</p></div>
      {draft.approved && <span className="badge live">approved</span>}</div>
    <form className="frame-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <label>Title<input value={draft.title} onChange={(event) => set("title", event.target.value)} required /></label>
      <label>Problem, clarified<textarea value={draft.restatedProblem}
        onChange={(event) => set("restatedProblem", event.target.value)} required /></label>
      <label>What the agents must produce<textarea className="short" value={draft.objective}
        onChange={(event) => set("objective", event.target.value)} required /></label>
      <fieldset className="acceptance-panel"><legend>Acceptance criteria</legend>
        <div className="acceptance-intro"><p>All criteria are required. Each should describe one compatible result and how the Observer can check it.</p>
          <span className="badge">{draft.acceptanceCriteria.length} / 6</span></div>
        <div className="acceptance-list">
          {draft.acceptanceCriteria.map((criterion, index) => <article className="criterion-card" key={criterion.id}>
            <header><span className="criterion-number">AC {index + 1}</span>
              <button type="button" className="criterion-remove"
                onClick={() => set("acceptanceCriteria", draft.acceptanceCriteria.filter((_, at) => at !== index))}
                disabled={draft.acceptanceCriteria.length === 1}>Remove</button></header>
            <label>Required result<textarea className="criterion-text" value={criterion.description}
              aria-label={`Criterion ${index + 1}`} placeholder="What must be true in the final answer?"
              onChange={(event) => set("acceptanceCriteria", draft.acceptanceCriteria.map((item, at) => at === index ? { ...item, description: event.target.value } : item))} /></label>
            <label>Observer verification<textarea className="criterion-text" value={criterion.verification}
              aria-label={`Verification ${index + 1}`} placeholder="How should the Observer verify this result?"
              onChange={(event) => set("acceptanceCriteria", draft.acceptanceCriteria.map((item, at) => at === index ? { ...item, verification: event.target.value } : item))} /></label>
          </article>)}
        </div>
        <button type="button" className="add-criterion" disabled={draft.acceptanceCriteria.length >= 6}
          onClick={() => set("acceptanceCriteria", [...draft.acceptanceCriteria, {
            id: `AC-${draft.acceptanceCriteria.length + 1}`, description: "", verification: "",
          }])}>+ Add acceptance criterion</button>
      </fieldset>
      <div className="form-grid">
        <label>Evidence / proof standard<textarea className="short" value={draft.evidenceStandard}
          onChange={(event) => set("evidenceStandard", event.target.value)} required /></label>
        <label>Maximum rounds<input type="number" min={1} value={draft.maxRounds}
          onChange={(event) => set("maxRounds", Number(event.target.value))} /></label>
      </div>
      {(save.error || approve.error) && <p className="error">{errorText(save.error ?? approve.error)}</p>}
      <div className="row"><button type="submit" disabled={busy}>Save</button>
        <button className="primary" type="button" disabled={busy} onClick={() => approve.mutate()}>Approve and continue</button></div>
    </form>
  </section>;
}
function MessageCard({ message }: { message: MessageView }) {
  const label = message.role === "answerer" ? "Answer Agent" : message.role === "observer" ? "Observer / Questioner" : "Task Framer";
  const text = message.text || (message.status === "streaming" ? "Waiting for model output…" : "No text returned.");

  return <article className={`message ${message.status}`}>
    <header><strong>{label}</strong><span>{message.round ? `Round ${message.round}` : "Framing"} · {message.status}</span></header>
    {message.reasoning && <details className="reasoning-panel" open={message.status === "streaming"}>
      <summary>Provider reasoning</summary>
      <Markdown className="reasoning">{message.reasoning}</Markdown>
    </details>}
    <section className="message-output">
      <div className="message-section-label">Output</div>
      <Markdown className="message-text">{text}</Markdown>
    </section>
  </article>;
}

function SessionView({ id }: { id: string }) {
  const [viewedStage, setViewedStage] = useState<number | "final" | null>(null);
  const client = useQueryClient();

  useEffect(() => setViewedStage(null), [id]);

  const session = useQuery({
    queryKey: ["session", id],
    queryFn: () => getSession(id),
    refetchInterval: 1_500,
  });
  const stream = useSessionEvents(id);
  const control = useMutation({
    mutationFn: (action: "start" | "pause" | "resume" | "cancel") => ({ start: startSession, pause: pauseSession, resume: resumeSession, cancel: cancelSession })[action](id),
    onSuccess: (value) => {
      client.setQueryData(["session", id], value);
      void client.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  if (session.isLoading) return <p className="muted">Loading session…</p>;
  if (session.error || !session.data) return <p className="error">{errorText(session.error)}</p>;
  const value = session.data;
  const framer = value.messages.filter((item) => item.role === "framer");
  const answers = value.messages.filter((item) => item.role === "answerer");
  const observations = value.messages.filter((item) => item.role === "observer" && !((item.metadata as Record<string, unknown> | undefined)?.final));
  const rounds = Array.from(new Set([...answers, ...observations].map((item) => item.round).filter((round) => round > 0))).sort((left, right) => left - right);
  const latestRound = rounds.at(-1) ?? 0;
  const stages: Array<number | "final"> = value.finalReport ? [...rounds, "final"] : rounds;
  const latestStage = stages.at(-1);
  const selectedStage = viewedStage !== null && stages.includes(viewedStage) ? viewedStage : latestStage;
  const selectedStageIndex = selectedStage === undefined ? -1 : stages.indexOf(selectedStage);
  const viewingFinal = selectedStage === "final";
  const selectedRound = typeof selectedStage === "number" ? selectedStage : latestRound;
  const selectedAnswers = answers.filter((message) => message.round === selectedRound);
  const selectedObservations = observations.filter((message) => message.round === selectedRound);
  const active = ["framing", "awaiting_approval", "ready", "running", "paused"].includes(value.status);

  return <div className="stack">
    <div className="toolbar row spread">
      <div><div className="row"><h2>{value.title}</h2><span className={`badge ${stream.connected ? "live" : ""}`}>{value.status}</span></div>
        <p className="muted">Round {value.currentRound} / {value.maxRounds} · stream {stream.connected ? "connected" : "reconnecting"}</p></div>
      <div className="row">
        {value.status === "ready" && <button onClick={() => control.mutate("start")}>Start debate</button>}
        {value.status === "running" && <button onClick={() => control.mutate("pause")}>Pause</button>}
        {value.status === "paused" && <button onClick={() => control.mutate("resume")}>Resume</button>}
        {active && <button className="danger" onClick={() => control.mutate("cancel")}>Cancel</button>}
      </div>
    </div>
    <div className="warning">Offline agents only: no web search, literature lookup, citation checking, code execution, or simulation runtime. Treat unsupplied references and external-result claims as unverified.</div>
    {value.error && <p className="error panel">{value.error}</p>}
    {control.error && <p className="error">{errorText(control.error)}</p>}

    {value.status === "framing" && <section className="panel stack"><h2>Task Framer is working</h2>
      <p className="progress">Converting the original problem into explicit scope, deliverables, acceptance criteria, and stop conditions.</p>
      {framer.map((message) => <MessageCard key={message.id} message={message} />)}
    </section>}
    {value.frame && (value.status === "awaiting_approval" || value.status === "ready") && <FrameEditor session={value} />}

    {stages.length > 0 && <>
      <nav className="round-pager panel" aria-label="Debate and final report navigation">
        <button
          disabled={selectedStageIndex <= 0}
          onClick={() => setViewedStage(stages[selectedStageIndex - 1] ?? null)}
        >← Previous</button>
        <div>{viewingFinal
          ? <><strong>Final report</strong><span> after round {latestRound}</span></>
          : <><strong>Round {selectedRound}</strong><span> of {latestRound}</span></>}
        </div>
        <button
          disabled={selectedStageIndex < 0 || selectedStageIndex >= stages.length - 1}
          onClick={() => {
            const next = stages[selectedStageIndex + 1];
            setViewedStage(next === latestStage ? null : (next ?? null));
          }}
        >Next →</button>
        <button className="current-round" disabled={selectedStage === latestStage} onClick={() => setViewedStage(null)}>Latest</button>
      </nav>
      {viewingFinal && value.finalReport
        ? <section className="panel final"><h2>Final research report</h2><Markdown className="report-text">{value.finalReport.text}</Markdown></section>
        : <section className="debate-grid">
          <div className="column">
            <div className="column-title">Answer Agent · Round {selectedRound}</div>
            {selectedAnswers.length > 0
              ? selectedAnswers.map((message) => <MessageCard key={message.id} message={message} />)
              : <div className="message empty-round">Waiting for the Answer Agent…</div>}
          </div>
          <div className="column">
            <div className="column-title">Observer / Questioner · Round {selectedRound}</div>
            {selectedObservations.length > 0
              ? selectedObservations.map((message) => <MessageCard key={message.id} message={message} />)
              : <div className="message empty-round">Waiting for the Observer / Questioner…</div>}
          </div>
        </section>}
    </>}

    {value.compactions.length > 0 && <section className="panel"><h3>Context compactions</h3><div className="notice-list">
      {value.compactions.map((item) => <details key={item.id}><summary>Compacted through round {item.round}</summary><div className="reasoning">{item.summary}</div></details>)}
    </div></section>}

    <section className="panel usage"><span>Input {value.usage.inputTokens.toLocaleString()}</span>
      <span>Output {value.usage.outputTokens.toLocaleString()}</span><span>Total {value.usage.totalTokens.toLocaleString()}</span>
      <span>Provider cost tracking: {value.usage.cost ? `$${value.usage.cost.toFixed(4)}` : "unavailable"}</span></section>
  </div>;
}
export function App() {
  const [selected, setSelected] = useState<string>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: getSessions });
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: deleteSession,
    onSuccess: (_value, id) => {
      client.removeQueries({ queryKey: ["session", id], exact: true });
      setSelected((current) => current === id ? undefined : current);
      void client.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  const removeExploration = (id: string, title: string) => {
    if (!window.confirm(`Delete "${title}" and all of its rounds, messages, and reports? This cannot be undone.`)) return;
    remove.mutate(id);
  };
  const created = (id: string) => {
    setSelected(id);
    void client.invalidateQueries({ queryKey: ["sessions"] });
  };
  return <div className={`app ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
    <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
      <div className="sidebar-header">
        {!sidebarCollapsed && <div className="brand"><h1>Argus</h1><span className="badge">Phase 1</span></div>}
        <button
          className="sidebar-toggle"
          aria-label={sidebarCollapsed ? "Expand exploration sidebar" : "Collapse exploration sidebar"}
          aria-expanded={!sidebarCollapsed}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
        >{sidebarCollapsed ? "→" : "←"}</button>
      </div>
      {!sidebarCollapsed && <div className="sidebar-content">
        <button className="new-button" onClick={() => setSelected(undefined)}>+ New exploration</button>
        <div className="session-list">
          {sessions.data?.map((session) => <div className="session-row" key={session.id}>
            <button
              className={`session-button ${selected === session.id ? "active" : ""}`}
              onClick={() => setSelected(session.id)}>
              <strong>{session.title}</strong><small>{session.status} · {session.currentRound}/{session.maxRounds}</small>
            </button>
            <button
              type="button"
              className="session-delete"
              aria-label={`Delete ${session.title}`}
              title="Delete exploration"
              disabled={remove.isPending && remove.variables === session.id}
              onClick={() => removeExploration(session.id, session.title)}
            >×</button>
          </div>)}
          {sessions.isLoading && <span className="muted">Loading sessions…</span>}
          {remove.error && <span className="error">{errorText(remove.error)}</span>}
        </div>
      </div>}
    </aside>
    <main className="main">{selected ? <SessionView id={selected} /> : <NewSession onCreated={created} />}</main>
  </div>;
}
