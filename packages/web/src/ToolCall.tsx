import type { ToolInvocation, ToolInvocationView } from "./types";

const VERDICT: Record<ToolInvocationView["state"], string> = {
  pending: "queued",
  running: "running",
  completed: "done",
  failed: "failed",
};

function argumentsOf(tool: ToolInvocation) {
  const entries = Object.entries(tool.arguments ?? {}).filter(
    ([, value]) => value !== "" && value !== null && value !== undefined,
  );
  return entries.map(([key, value]) =>
    `${key}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
}

function duration(tool: ToolInvocation) {
  if (!tool.endedAt || !tool.startedAt) return "";
  const ms = tool.endedAt - tool.startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * One tool call, rendered where it happened. Its result lands inside this same block, so the
 * turn reads in the order the model worked: reasoning, then the call and its output, then more.
 */
export function ToolCall({ tool, open = false }: { tool: ToolInvocationView; open?: boolean }) {
  const args = argumentsOf(tool);
  const body = tool.state === "failed" ? tool.error ?? "" : tool.output;
  const elapsed = duration(tool);
  const failed = tool.state === "failed";

  return <details className={`call ${tool.state}`} open={failed || open}>
    <summary>
      <span className="call-name">{tool.name}</span>
      <span className="call-target">{tool.title || "(no target)"}</span>
      <span className={`call-verdict ${tool.state}`}>{VERDICT[tool.state]}</span>
      {elapsed && <span className="call-verdict">{elapsed}</span>}
    </summary>
    <div className="call-body">
      {args.length > 0 && <pre>{args.join("\n")}</pre>}
      {body
        ? <pre className={failed ? "failed" : undefined}>{body}</pre>
        : tool.state === "running" ? <p className="faint call-running">Still running…</p> : null}
    </div>
  </details>;
}

export function ToolCallList({ tools }: { tools: ToolInvocationView[] }) {
  if (tools.length === 0) return null;
  const failed = tools.filter((tool) => tool.state === "failed").length;

  return <details className="evidence">
    <summary>
      <span>{tools.length} tool {tools.length === 1 ? "call" : "calls"}</span>
      {failed > 0 && <span className="bad">{failed} failed</span>}
    </summary>
    <div className="calls">
      {tools.map((tool) => <ToolCall key={tool.id} tool={tool} />)}
    </div>
  </details>;
}

export function toolCallsOf(message: { metadata?: unknown }): ToolInvocationView[] {
  const metadata = message.metadata as Record<string, unknown> | undefined;
  const calls = metadata?.toolCalls;
  return Array.isArray(calls) ? (calls as ToolInvocationView[]) : [];
}
