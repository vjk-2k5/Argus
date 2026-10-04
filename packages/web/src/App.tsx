import { FormEvent, Fragment, useEffect, useState } from "react";
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
  getTools,
  pauseSession,
  resumeSession,
  startSession,
  updateFrame,
  updateSessionTools,
} from "./api";
import { useSessionEvents } from "./hooks";
import { ProviderSettings } from "./ProviderSettings";
import { DirectoryPicker } from "./DirectoryPicker";
import { ModelPicker } from "./ModelPicker";
import { Markdown } from "./Markdown";
import { ToolCall, ToolCallList, toolCallsOf } from "./ToolCall";
import { VerdictStrip, rulingsOf } from "./Ledger";import type {
  FrameView,
  MessageView,
  RoleModel,
  SessionDetailView,
  ToolAccess,
  ToolInvocationView,
} from "./types";

function partsOf(message: { metadata?: unknown }) {
  const metadata = message.metadata as Record<string, unknown> | undefined;
  const parts = metadata?.parts;
  return Array.isArray(parts) ? (parts as Array<{ id: string; kind: "text" | "reasoning" | "tool"; text: string; toolId?: string }>) : [];
}

const TOOL_ACCESS: Array<{ value: ToolAccess; label: string; hint: string }> = [
  { value: "full", label: "Full", hint: "Read, write, run commands, search the web." },
  { value: "read", label: "Read-only", hint: "Inspect files and the web. No changes." },
  { value: "off", label: "No tools", hint: "Model knowledge only. Nothing can be checked." },
];

const STATE: Record<string, { label: string; dot: string }> = {
  framing: { label: "Framing the task", dot: "live" },
  awaiting_approval: { label: "Waiting for your approval", dot: "paused" },
  ready: { label: "Approved, ready to start", dot: "" },
  running: { label: "In progress", dot: "live" },
  paused: { label: "Paused", dot: "paused" },
  completed: { label: "Complete", dot: "done" },
  cancelled: { label: "Cancelled", dot: "" },
  failed: { label: "Failed", dot: "bad" },
};

const SPEAKER: Record<string, string> = {
  framer: "Task Framer",
  answerer: "Answer Agent",
  observer: "Observer",
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

function model(providerID = "", modelID = ""): RoleModel {
  return { providerID: providerID as RoleModel["providerID"], modelID, options: {} };
}

function shortDate(value: number) {
  return new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/* ─── new exploration ───────────────────────────────────────────────────── */

function Intro({ onCreated }: { onCreated: (id: string) => void }) {
  const providers = useQuery({ queryKey: ["providers"], queryFn: getProviders });
  const tools = useQuery({ queryKey: ["tools"], queryFn: getTools });
  const [problem, setProblem] = useState("");
  const [maxRounds, setMaxRounds] = useState(6);
  const [toolAccess, setToolAccess] = useState<ToolAccess>("full");
  const [workspace, setWorkspace] = useState("");
  const [framer, setFramer] = useState<RoleModel>(model());
  const [answerer, setAnswerer] = useState<RoleModel>(model());
  const [observer, setObserver] = useState<RoleModel>(model());
  const [perRole, setPerRole] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!providers.data) return;
    setFramer((value) => (value.modelID ? value : providers.data!.defaults.framer));
    setAnswerer((value) => (value.modelID ? value : providers.data!.defaults.answerer));
    setObserver((value) => (value.modelID ? value : providers.data!.defaults.observer));
  }, [providers.data]);

  const create = useMutation({ mutationFn: createSession, onSuccess: (session) => onCreated(session.id) });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({
      problem,
      maxRounds,
      roles: { framer, answerer, observer },
      toolAccess,
      ...(toolAccess !== "off" && workspace.trim() ? { workspace: workspace.trim() } : {}),
    });
  };

  const enabled = tools.data?.tools.filter((item) => toolAccess === "full" || item.access === "read") ?? [];
  const writes = enabled.filter((item) => item.mutating);
  const reads = enabled.filter((item) => !item.mutating);
  const connected = providers.data?.providers.filter((item) => item.configured).length ?? 0;
  const allProviders = providers.data?.providers ?? [];

  return <div className="intro">
    <div className="intro-statement">
      <h1>One model answers. The other tries to break it.</h1>
      <p>Argus turns a loose problem into a bounded task before any agent starts working on it.</p>
      <dl className="roles">
        <div>
          <dt>Task Framer</dt>
          <dd>Writes the scope, the deliverables, and the acceptance criteria. You read them and approve or edit them.</dd>
        </div>
        <div>
          <dt>Answer Agent</dt>
          <dd>Works the problem, and has to produce something that satisfies every criterion at once.</dd>
        </div>
        <div>
          <dt>Observer</dt>
          <dd>Re-derives each criterion with its own tools, then rules it met or not met with a reason. It cannot take the Answer Agent's word.</dd>
        </div>
      </dl>
    </div>

    <form className="intro-form" onSubmit={submit}>
      <div className="field">
        <label className="label" htmlFor="problem">Your problem</label>
        <textarea id="problem" className="problem-input" value={problem} required
          onChange={(event) => setProblem(event.target.value)}
          placeholder="What do you want settled, and what would count as settled?" />
      </div>

      <details className="reveal">
        <summary>
          <b>Run settings</b>
          <span className="aside">
            {plural(maxRounds, "round", "rounds")}, {TOOL_ACCESS.find((item) => item.value === toolAccess)?.label.toLowerCase()} tools,
            {" "}{perRole ? "a model per role" : "one model"}
          </span>
        </summary>
        <div className="reveal-body">
          <div className="field-row">
            <div className="field">
              <label className="label" htmlFor="rounds">Round limit</label>
              <input id="rounds" className="field-narrow" type="number" min={1} max={40} value={maxRounds}
                onChange={(event) => setMaxRounds(Number(event.target.value))} required />
            </div>
            <div className="field">
              <span className="label">Agent models</span>
              <div className="plain-row" style={{ paddingTop: 0, borderTop: 0, gap: 10 }}>
                <span className="faint" style={{ fontSize: 13.5 }}>
                  {perRole ? "A different model per role." : "The same model in all three roles."}
                </span>
                <button type="button" className="link" onClick={() => setPerRole((value) => !value)}>
                  {perRole ? "Use one model" : "Split by role"}
                </button>
              </div>
            </div>
          </div>

          {providers.data && <>
            <div className="models">
              {perRole
                ? <>
                  <ModelPicker label="Task Framer" value={framer} onChange={setFramer} providers={allProviders} />
                  <ModelPicker label="Answer Agent" value={answerer} onChange={setAnswerer} providers={allProviders} />
                  <ModelPicker label="Observer" value={observer} onChange={setObserver} providers={allProviders} />
                </>
                : <ModelPicker label="All three agents" value={answerer} providers={allProviders}
                  onChange={(value) => { setFramer(value); setAnswerer(value); setObserver(value); }} />}
            </div>

            <div className="plain-row">
              <div>
                <span className="label">Providers</span>
                <span className="faint" style={{ fontSize: 13.5 }}>
                  {connected === 0 ? "None connected — the debate cannot run yet." : `${connected} of ${allProviders.length} connected.`}
                </span>
              </div>
              <button type="button" onClick={() => setCredentialsOpen(true)}>Manage API keys</button>
            </div>
          </>}
          {providers.isLoading && <p className="faint" style={{ fontSize: 13.5 }}>Loading providers…</p>}
          {providers.error && <p className="problem"><b>Providers could not load.</b> {errorText(providers.error)}</p>}

          <div className="field">
            <span className="label">What the agents may do</span>
            <div className="segmented" role="group" aria-label="Tool access">
              {TOOL_ACCESS.map((option) => <button type="button" key={option.value}
                aria-pressed={toolAccess === option.value} onClick={() => setToolAccess(option.value)}>
                {option.label}<small>{option.hint}</small>
              </button>)}
            </div>
          </div>

          {toolAccess !== "off" && <div className="field">
            <span className="label">
              Working directory <span className="faint" style={{ fontWeight: 400 }}>(optional)</span>
            </span>
            <div className="dir-chosen">
              <span className={workspace ? "mono" : "faint"} title={workspace || undefined}>
                {workspace || "No folder chosen — Argus will create one for this exploration"}
              </span>
              <span className="dir-chosen-actions">
                <button type="button" onClick={() => setPickerOpen(true)}>{workspace ? "Change" : "Choose folder"}</button>
                {workspace && <button type="button" className="link" onClick={() => setWorkspace("")}>Clear</button>}
              </span>
            </div>
            <p className="faint" style={{ fontSize: 13 }}>
              Give the agents an existing folder to work in — it becomes the only place they can read and write.
              Leave it blank and Argus creates a fresh folder under <code className="mono">{tools.data?.sessionsRoot ?? "the sessions root"}</code>.
            </p>
          </div>}

          {tools.data && enabled.length > 0 && <div className="kit">
            {reads.length > 0 && <div className="kit-group">
              <span className="label">Available to inspect</span>
              <div className="kit-words">{reads.map((item) => <span key={item.name}>{item.name}</span>)}</div>
            </div>}
            {writes.length > 0 && <div className="kit-group">
              <span className="label">Can change your files and run commands</span>
              <div className="kit-words">{writes.map((item) => <span className="write" key={item.name}>{item.name}</span>)}</div>
            </div>}
            <p className="faint" style={{ fontSize: 13.5 }}>
              Each exploration gets its own folder at <code className="mono">{tools.data.sessionsRoot}</code>, and nothing outside it can be touched.
              {tools.data.shell ? ` Shell: ${tools.data.shell}.` : ""}
            </p>
          </div>}
        </div>
      </details>

      {create.error && <p className="problem" role="alert"><b>Could not start the exploration.</b> {errorText(create.error)}</p>}

      <div className="intro-actions">
        <button className="primary" type="submit" disabled={create.isPending || !providers.data || !problem.trim()}>
          {create.isPending ? "Starting…" : "Frame the problem"}
        </button>
        <span className="dim" style={{ fontSize: 13.5 }}>
          The Task Framer drafts the criteria next. Nothing runs until you approve them.
        </span>
      </div>
    </form>

    <ProviderSettings open={credentialsOpen} onClose={() => setCredentialsOpen(false)} />
    <DirectoryPicker open={pickerOpen} initial={workspace || undefined}
      onClose={() => setPickerOpen(false)} onSelect={setWorkspace} />
  </div>;
}

/* ─── approval of the task frame ────────────────────────────────────────── */

function editable(frame: FrameView): Frame {
  const { approved: _approved, ...value } = frame;
  return value;
}

function FrameEditor({ session }: { session: SessionDetailView }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<FrameView>(session.frame!);
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
  const set = <K extends keyof FrameView>(key: K, value: FrameView[K]) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const replaceCriterion = (at: number, patch: Partial<FrameView["acceptanceCriteria"][number]>) =>
    set("acceptanceCriteria", draft.acceptanceCriteria.map((item, index) => (index === at ? { ...item, ...patch } : item)));

  return <div className="framing-list">
    <div className="framing">
      <p className="label">The Task Framer's proposal</p>
      <p className="dim" style={{ fontSize: 15 }}>
        Nothing has run yet. Edit anything that is wrong, then approve to let the Answer Agent and Observer start.
      </p>
    </div>

    <form className="frame-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <div className="field">
        <label className="label" htmlFor="frame-title">Title</label>
        <input id="frame-title" value={draft.title} onChange={(event) => set("title", event.target.value)} required />
      </div>
      <div className="field">
        <label className="label" htmlFor="frame-problem">The problem, restated</label>
        <textarea id="frame-problem" value={draft.restatedProblem}
          onChange={(event) => set("restatedProblem", event.target.value)} required />
      </div>
      <div className="field">
        <label className="label" htmlFor="frame-objective">What the agents must produce</label>
        <textarea id="frame-objective" value={draft.objective} className="tall"
          onChange={(event) => set("objective", event.target.value)} required />
      </div>

      <div className="field">
        <span className="label">Acceptance criteria — all {draft.acceptanceCriteria.length} must hold</span>
        <p className="faint" style={{ fontSize: 13 }}>
          One compatible result each, with a check the Observer can actually run. Vague criteria produce arguments, not answers.
        </p>
        <div className="criteria-edit">
          {draft.acceptanceCriteria.map((criterion, index) => <div className="criterion-edit" key={criterion.id}>
            <div className="criterion-edit-head">
              <span className="mono">{criterion.id}</span>
              <button type="button" className="link" disabled={draft.acceptanceCriteria.length === 1}
                onClick={() => set("acceptanceCriteria", draft.acceptanceCriteria.filter((_, at) => at !== index))}>
                Remove
              </button>
            </div>
            <div className="field">
              <label className="label" htmlFor={`criterion-${criterion.id}`}>Required result</label>
              <textarea id={`criterion-${criterion.id}`} value={criterion.description}
                placeholder="What must be true in the final answer?"
                onChange={(event) => replaceCriterion(index, { description: event.target.value })} />
            </div>
            <div className="field">
              <label className="label" htmlFor={`verify-${criterion.id}`}>How the Observer checks it</label>
              <textarea id={`verify-${criterion.id}`} value={criterion.verification} className="shorter"
                placeholder="A file to read, a command to run, a source to fetch."
                onChange={(event) => replaceCriterion(index, { verification: event.target.value })} />
            </div>
          </div>)}
        </div>
        <button type="button" className="link" style={{ justifySelf: "start" }}
          disabled={draft.acceptanceCriteria.length >= 6}
          onClick={() => set("acceptanceCriteria", [...draft.acceptanceCriteria, {
            id: `AC-${draft.acceptanceCriteria.length + 1}`, description: "", verification: "",
          }])}>
          Add a criterion
        </button>
      </div>

      <div className="field-row">
        <div className="field">
          <label className="label" htmlFor="frame-evidence">Evidence standard</label>
          <textarea id="frame-evidence" value={draft.evidenceStandard} className="shorter"
            onChange={(event) => set("evidenceStandard", event.target.value)} required />
        </div>
        <div className="field">
          <label className="label" htmlFor="frame-rounds">Round limit</label>
          <input id="frame-rounds" className="field-narrow" type="number" min={1} value={draft.maxRounds}
            onChange={(event) => set("maxRounds", Number(event.target.value))} />
        </div>
      </div>

      {(save.error || approve.error) && <p className="problem" role="alert">{errorText(save.error ?? approve.error)}</p>}
      <div className="frame-actions">
        <button className="primary" type="button" disabled={busy} onClick={() => approve.mutate()}>
          {approve.isPending ? "Approving…" : "Approve and start the debate"}
        </button>
        <button type="submit" disabled={busy}>{save.isPending ? "Saving…" : "Save without approving"}</button>
      </div>
    </form>
  </div>;
}

/* ─── the record: one agent turn ────────────────────────────────────────── */

/** One question aimed at the operator, rendered at the point the agent asked it. */
function Asked({ tool }: { tool: ToolInvocationView }) {
  const options = Array.isArray(tool.arguments?.options) ? (tool.arguments.options as string[]) : [];
  return <div className="ask">
    <b>Asked you</b>
    <p>{typeof tool.arguments?.question === "string" ? tool.arguments.question : tool.title}</p>
    {options.length > 0 && <ul>{options.map((option) => <li key={option}>{option}</li>)}</ul>}
    <span className="label">The run continues without waiting for your answer.</span>
  </div>;
}

function ReasoningBlock({ text, label }: { text: string; label: string }) {
  return <details className="reasoning" open>
    <summary>{label}</summary>
    <Markdown className="dim">{text}</Markdown>
  </details>;
}

/**
 * Reconstructs the turn from its ordered parts. Older messages stored no parts, so they fall
 * back to the flat reasoning-then-text layout.
 */
function TurnParts({ message }: { message: MessageView }) {
  const parts = partsOf(message);
  const tools = new Map(toolCallsOf(message).map((tool) => [tool.id, tool]));
  const question = toolCallsOf(message)
    .find((tool) => tool.name === "question" && tool.state === "completed");

  if (parts.length === 0) {
    const activity = toolCallsOf(message).filter((tool) => tool.name !== "question");
    return <>
      {activity.length > 0 && <ToolCallList tools={activity} />}
      {message.reasoning && <ReasoningBlock text={message.reasoning} label="Model reasoning" />}
      {message.text
        ? <Markdown>{message.text}</Markdown>
        : message.status === "streaming" ? <p className="waiting">Thinking…</p>
          : <p className="waiting">Nothing returned.</p>}
      {question && <Asked tool={question} />}
    </>;
  }

  const rendered = parts.map((part) => {
    if (part.kind === "tool") {
      const tool = part.toolId ? tools.get(part.toolId) : undefined;
      if (!tool) return null;
      return tool.name === "question" && tool.state === "completed"
        ? <Asked key={part.id} tool={tool} />
        : <ToolCall key={part.id} tool={tool} />;
    }
    const label = part.kind === "reasoning" ? "Model reasoning" : "";
    if (part.kind === "reasoning") {
      return part.text ? <ReasoningBlock key={part.id} text={part.text} label={label} /> : null;
    }
    return part.text ? <Markdown key={part.id}>{part.text}</Markdown> : null;
  });

  // A part may still be filling while the turn streams; say so rather than showing nothing.
  if (!parts.some((part) => part.kind === "text" && part.text)) {
    rendered.push(<p className="waiting" key="waiting">Thinking…</p>);
  }
  return <>{rendered}</>;
}

/** Why a turn stopped early, stated plainly so a cut response never reads as a finished one. */
function CutNotice({ message }: { message: MessageView }) {
  const metadata = message.metadata as Record<string, unknown> | undefined;
  const cut = typeof metadata?.cut === "string" ? metadata.cut : undefined;
  if (!cut) return null;
  const continuation = typeof metadata?.continuation === "number" ? metadata.continuation : 0;
  const why = cut === "length"
    ? "hit the model's output limit"
    : cut === "steps"
      ? "hit the tool-step limit"
      : "was stopped by the provider";
  return <p className="cut-note">
    <b>This turn {why}</b>
    {continuation > 0
      ? ` and was continued ${continuation} time${continuation === 1 ? "" : "s"} in the same round rather than passing a partial answer on.`
      : " and is being continued in the same round rather than passing a partial answer on."}
  </p>;
}

function Turn({ message, index = 0, heading = false }: {
  message: MessageView;
  index?: number;
  heading?: boolean;
}) {
  const metadata = message.metadata as Record<string, unknown> | undefined;
  const continuation = typeof metadata?.continuation === "number" ? metadata.continuation : 0;
  return <article className={`turn ${message.role} ${message.status}`}>
    {/* In the split the column heading already names the agent, so the turn does not repeat it. */}
    <header className="turn-head">
      {heading
        ? <>
          {index > 0 && <span className="label">Message {index + 1}</span>}
          {continuation > 0 && <span className="label">continued</span>}
          {message.status === "streaming" && <span className="reasoning-live">streaming</span>}
          {message.status === "aborted" && <span className="label">Stopped early</span>}
          {message.status === "failed" && <span className="label">Failed</span>}
        </>
        : <>
          <b>{SPEAKER[message.role] ?? message.role}</b>
          <span className="label">{message.round ? `Round ${message.round}` : "Framing"}</span>
          {continuation > 0 && <span className="label">continued</span>}
          {message.status === "aborted" && <span className="label">Stopped early</span>}
          {message.status === "failed" && <span className="label">Failed</span>}
        </>}
    </header>

    <CutNotice message={message} />

    <TurnParts message={message} />
  </article>;
}

/* ─── conditions of the run, folded under the contract ─────────────────── */

function RunConditions({ value, editable: open }: { value: SessionDetailView; editable: boolean }) {
  const client = useQueryClient();
  const [copied, setCopied] = useState(false);
  const control = useMutation({
    mutationFn: (toolAccess: ToolAccess) => updateSessionTools(value.id, toolAccess),
    onSuccess: (next) => client.setQueryData(["session", value.id], next),
  });

  const copyPath = () => {
    void navigator.clipboard?.writeText(value.workspace);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const rows = [
    ["Framer", value.roles.framer.modelID],
    ["Answerer", value.roles.answerer.modelID],
    ["Observer", value.roles.observer.modelID],
  ] as const;

  return <details className="conditions">
    <summary>Run conditions</summary>
    <div className="conditions-body">
      <div className="condition">
        <span className="label">Tool access</span>
        {open
          ? <div className="segmented" role="group" aria-label="Tool access">
            {TOOL_ACCESS.map((option) => <button type="button" key={option.value}
              aria-pressed={value.toolAccess === option.value}
              disabled={control.isPending || value.toolAccess === option.value}
              onClick={() => control.mutate(option.value)}>{option.label}</button>)}
          </div>
          : <span className="condition-value">{TOOL_ACCESS.find((item) => item.value === value.toolAccess)?.label}</span>}
        {control.error && <p className="problem" style={{ fontSize: 13 }}>{errorText(control.error)}</p>}
      </div>

      {value.toolAccess !== "off" && value.workspace && <div className="condition">
        <span className="label">Workspace</span>
        <span className="condition-value mono">{value.workspace}</span>
        <button type="button" className="conditions-copy" onClick={copyPath}>{copied ? "Copied" : "Copy path"}</button>
      </div>}

      <div className="condition">
        <span className="label">Models</span>
        <dl>{rows.map(([name, id]) => <Fragment key={name}><dt>{name}</dt><dd title={id}>{id || "—"}</dd></Fragment>)}</dl>
      </div>

      <div className="condition">
        <span className="label">Spend</span>
        <dl>
          <dt>Input</dt><dd>{value.usage.inputTokens.toLocaleString()}</dd>
          <dt>Output</dt><dd>{value.usage.outputTokens.toLocaleString()}</dd>
          <dt>Cost</dt><dd>{value.usage.cost != null ? `$${value.usage.cost.toFixed(4)}` : "—"}</dd>
        </dl>
      </div>

      {value.compactions.length > 0 && <div className="condition">
        <span className="label">Context compacted</span>
        {value.compactions.map((item) => <div key={item.id}>
          <span className="condition-value">after round {item.round}</span>
          <details className="notes" style={{ marginTop: 6 }}>
            <summary>What was dropped</summary>
            <div className="notes-body"><p className="note">{item.summary}</p></div>
          </details>
        </div>)}
      </div>}
    </div>
  </details>;
}

/* ─── one exploration ───────────────────────────────────────────────────── */

function SessionView({ id, onReading }: { id: string; onReading: (reading: boolean) => void }) {
  const [viewed, setViewed] = useState<number | "final" | null>(null);
  const client = useQueryClient();

  useEffect(() => setViewed(null), [id]);

  const session = useQuery({
    queryKey: ["session", id],
    queryFn: () => getSession(id),
    refetchInterval: 1_500,
  });
  const stream = useSessionEvents(id);
  const control = useMutation({
    mutationFn: (action: "start" | "pause" | "resume" | "cancel") =>
      ({ start: startSession, pause: pauseSession, resume: resumeSession, cancel: cancelSession })[action](id),
    onSuccess: (next) => {
      client.setQueryData(["session", id], next);
      void client.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  // The rail steps aside whenever two agents are arguing side by side, because the
  // split needs the width more than the session index does.
  const live = session.data;
  const debating = (live?.status === "running" || live?.status === "paused")
    && (live?.messages.some((item) => item.round > 0) ?? false);
  useEffect(() => { if (debating) onReading(true); }, [debating, onReading]);

  if (session.isLoading) return <div className="empty-view"><h2>Loading…</h2></div>;
  if (session.error || !session.data) {
    return <div className="empty-view">
      <h2>This exploration could not be opened</h2>
      <p className="problem">{errorText(session.error)}</p>
    </div>;
  }

  const value = session.data;
  const framer = value.messages.filter((item) => item.role === "framer");
  const answers = value.messages.filter((item) => item.role === "answerer");
  const observations = value.messages.filter((item) => item.role === "observer"
    && !((item.metadata as Record<string, unknown> | undefined)?.final));
  const rounds = [...new Set([...answers, ...observations].map((item) => item.round).filter((round) => round > 0))]
    .sort((left, right) => left - right);
  const stages: Array<number | "final"> = value.finalReport ? [...rounds, "final"] : rounds;
  const latest = stages.at(-1);
  const stage = viewed !== null && stages.includes(viewed) ? viewed : latest;
  const round = typeof stage === "number" ? stage : rounds.at(-1) ?? 0;

  const state = STATE[value.status] ?? { label: value.status, dot: "" };
  const stateText = value.status === "running" ? `Round ${value.currentRound} of ${value.maxRounds}, in progress` : state.label;
  const open = !["completed", "cancelled", "failed"].includes(value.status);
  const inDebate = typeof stage === "number" && stage > 0 && value.status !== "awaiting_approval";
  const roundAnswers = answers.filter((item) => item.round === round);
  const roundObservations = observations.filter((item) => item.round === round);

  return <div className="session">
    <header className="session-head">
      <div className="head-row">
        <div style={{ minWidth: 0 }}>
          <h1>{value.title}</h1>
          <div className="head-meta" style={{ marginTop: 6 }}>
            <span className="state"><span className={`dot ${state.dot}`} aria-hidden="true" />{stateText}</span>
            <span className="mono">{stream.connected ? "stream live" : "stream reconnecting"}</span>
            <span className="mono optional">started {shortDate(value.createdAt)}</span>
          </div>
        </div>
        <div className="head-actions">
          {value.status === "ready" && <button className="primary" onClick={() => control.mutate("start")}>Start the debate</button>}
          {value.status === "running" && <button onClick={() => control.mutate("pause")}>Pause</button>}
          {value.status === "paused" && <button className="primary" onClick={() => control.mutate("resume")}>Resume</button>}
          {open && <button className="danger" onClick={() => control.mutate("cancel")}>Stop and discard</button>}
        </div>
      </div>

      {stages.length > 1 && <div className="rounds">
        <span className="label">Rounds</span>
        <div className="round-track" role="group" aria-label="Choose a round">
          {rounds.map((item) => <button key={item} aria-pressed={stage === item}
            onClick={() => setViewed(item === latest ? null : item)}>{item}</button>)}
          {value.finalReport && <button className="report-stop" aria-pressed={stage === "final"}
            onClick={() => setViewed("final")}>report</button>}
        </div>
      </div>}
    </header>

    {value.error && <div className="split-pane" style={{ flex: "none", paddingBottom: 0 }}>
      <p className="problem" role="alert"><b>The run reported a problem.</b> {value.error}</p>
    </div>}
    {control.error && <div className="split-pane" style={{ flex: "none", paddingBottom: 0 }}>
      <p className="problem" role="alert">{errorText(control.error)}</p>
    </div>}

    <VerdictStrip frame={value.frame} rulings={rulingsOf(value.messages)} compact={inDebate}>
      <RunConditions value={value} editable={open} />
    </VerdictStrip>

    {value.status === "framing" ? <div className="split-pane">
      <div className="framing">
        <p className="label">Framing</p>
        <p className="dim">The Task Framer is turning your problem into scope, deliverables, and criteria you can approve.</p>
      </div>
      {framer.length > 0 ? framer.map((message) => <Turn key={message.id} message={message} />)
        : <p className="waiting">Waiting for the first token…</p>}
    </div>

      : value.status === "awaiting_approval" ? <div className="split-pane">
        <FrameEditor session={value} />
      </div>

        : value.status === "ready" ? <div className="split-pane">
          <div className="framing">
            <p className="label">Approved</p>
            <p className="dim">Nothing has run. Start the debate when you are ready — the Observer will begin ruling on each criterion from round one.</p>
          </div>
        </div>

          : stage === "final" && value.finalReport ? <div className="split-pane">
            <article className="report">
              <div className={`ending ${value.finalReport.terminationKind === "criteria_met" ? "met" : "open"}`}>
                <b>{value.finalReport.terminationKind === "criteria_met" ? "Closed on the criteria" : "Stopped at the round limit"}</b>
                {value.finalReport.terminationReason && <p>{value.finalReport.terminationReason}</p>}
              </div>
              {value.unverifiedModelClaims && <p className="flag">
                <b>Some claims were never checked.</b> The agents asserted them without a tool call behind them. Treat those parts as unverified.
              </p>}
              <Markdown>{value.finalReport.text}</Markdown>
            </article>
          </div>

            : inDebate ? <div className="split">
              <section className="split-col">
                <div className="split-head">
                  <b>Answer Agent</b>
                  <span className="label">Round {round}</span>
                </div>
                {roundAnswers.length > 0
                  ? roundAnswers.map((message, at) => <Turn key={message.id} message={message} index={at} heading />)
                  : <div className="split-waiting">
                    <b>Nothing from the Answer Agent this round</b>
                    <p>{round === latest && value.status === "running" ? "It is working now…" : "It produced no answer."}</p>
                  </div>}
              </section>

              <section className="split-col">
                <div className="split-head">
                  <b>Observer</b>
                  <span className="label">Round {round}</span>
                </div>
                {roundObservations.length > 0
                  ? roundObservations.map((message, at) => <Turn key={message.id} message={message} index={at} heading />)
                  : <div className="split-waiting">
                    <b>No ruling this round</b>
                    <p>{round === latest && value.status === "running" ? "The Observer is checking the criteria…" : "The Observer did not report."}</p>
                  </div>}
              </section>
            </div>

              : <div className="split-pane">
                <p className="waiting">No rounds yet.</p>
              </div>}
  </div>;
}

/* ─── shell ─────────────────────────────────────────────────────────────── */

export function App() {
  const [selected, setSelected] = useState<string>();
  const [railOpen, setRailOpen] = useState(false);
  const [railWide, setRailWide] = useState(true);
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: getSessions });
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: deleteSession,
    onSuccess: (_result, id) => {
      client.removeQueries({ queryKey: ["session", id], exact: true });
      setSelected((current) => (current === id ? undefined : current));
      void client.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  // Two agents arguing need the width more than the session index does, so the rail
  // folds to a 54px strip. Hovering the "A" brings it back for as long as you hold it.
  const open = (id?: string) => {
    setSelected(id);
    setRailOpen(false);
  };
  const collapsed = !railWide;
  const list = sessions.data ?? [];

  return <div className={`app ${collapsed ? "rail-collapsed" : ""} ${selected ? "viewing" : ""}`}>
    <nav className="rail" data-open={railOpen} aria-label="Explorations">
      <button className="rail-expand" aria-label="Show explorations" title="Show explorations"
        onPointerEnter={() => setRailWide(true)}>A</button>
      <div className="rail-head">
        <div className="wordmark"><strong>Argus</strong><em>adversarial</em></div>
        <button className="rail-toggle" aria-expanded={railOpen} onClick={() => setRailOpen((value) => !value)}>
          {railOpen ? "Hide" : `Explorations${list.length ? ` (${list.length})` : ""}`}
        </button>
      </div>
      <button className="rail-new" onClick={() => open(undefined)}>
        <b>New exploration</b><span aria-hidden="true">+</span>
      </button>
      {railWide && <button className="rail-fold quiet" onClick={() => setRailWide(false)}>Hide the list</button>}
      <div className="rail-scroll">
        <div className="rail-group">
          {list.map((session) => {
            const state = STATE[session.status] ?? { label: session.status, dot: "" };
            return <div className="session-row" key={session.id}>
              <button className="session" aria-current={selected === session.id} onClick={() => open(session.id)}>
                <span className="session-name">{session.title}</span>
                <span className="session-round">{session.currentRound}/{session.maxRounds}</span>
                <span className="session-state">
                  {state.dot && <span className={`dot ${state.dot}`} aria-hidden="true" />}
                  {state.label}
                </span>
              </button>
              <button className="session-drop" aria-label={`Delete ${session.title}`}
                disabled={remove.isPending && remove.variables === session.id}
                onClick={() => {
                  if (window.confirm(`Delete "${session.title}" and all of its rounds, messages, and reports? This cannot be undone.`)) {
                    remove.mutate(session.id);
                  }
                }}>×</button>
            </div>;
          })}
          {sessions.isLoading && <p className="faint" style={{ fontSize: 13, padding: "4px 10px" }}>Loading…</p>}
          {!sessions.isLoading && !list.length && <p className="faint" style={{ fontSize: 13, padding: "4px 10px" }}>
            No explorations yet.
          </p>}
        </div>
      </div>
      {remove.error && <div className="rail-foot"><p className="problem" style={{ fontSize: 12.5 }}>{errorText(remove.error)}</p></div>}
    </nav>

    <main className="main">
      {selected ? <SessionView id={selected} onReading={() => setRailWide(false)} />
        : <Intro onCreated={open} />}
    </main>
  </div>;
}
