import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FrameView, MessageView } from "./types";

const COMPACT = "(max-width: 900px)";

export interface Ruling {
  criterionId: string;
  status: "met" | "not_met";
  rationale: string;
  round: number;
}

const VERDICT_WORD = { met: "verified", not_met: "not met" } as const;
const VERDICT_CLASS = { met: "met", not_met: "not_met" } as const;

/** Latest Observer ruling per criterion, taken from each observer message's control block. */
export function rulingsOf(messages: MessageView[]): Ruling[] {
  const latest = new Map<string, Ruling>();
  for (const message of messages) {
    if (message.role !== "observer") continue;
    const metadata = message.metadata as Record<string, unknown> | undefined;
    const control = metadata?.criterionEvaluations
      ? metadata
      : (metadata?.control as Record<string, unknown> | undefined);
    const evaluations = control?.criterionEvaluations;
    if (!Array.isArray(evaluations)) continue;
    for (const entry of evaluations) {
      const item = entry as { criterionId?: unknown; status?: unknown; rationale?: unknown };
      if (typeof item.criterionId !== "string") continue;
      if (item.status !== "met" && item.status !== "not_met") continue;
      latest.set(item.criterionId, {
        criterionId: item.criterionId,
        status: item.status,
        rationale: typeof item.rationale === "string" ? item.rationale : "",
        round: message.round,
      });
    }
  }
  return [...latest.values()];
}

/**
 * The contract, on one line. A run of marks reads as a score at a glance; opening it
 * gives the requirement, the Observer's ruling, its reason, and the check it used.
 */
export function VerdictStrip({ frame, rulings, compact, children }: {
  frame?: FrameView;
  rulings: Ruling[];
  /** True while the two agents are arguing; the strip stays one line and says less. */
  compact: boolean;
  children?: ReactNode;
}) {
  const byId = new Map(rulings.map((item) => [item.criterionId, item]));
  const criteria = frame?.acceptanceCriteria ?? [];
  const verified = criteria.filter((item) => byId.get(item.id)?.status === "met").length;
  const challenged = criteria.filter((item) => byId.get(item.id)?.status === "not_met").length;
  const settled = criteria.some((item) => byId.has(item.id));
  const thin = compact || (typeof window !== "undefined" && window.matchMedia(COMPACT).matches);

  // On a narrow screen the strip is one line and stays that way. On a wide screen it
  // opens itself when something is contested, because that is the news.
  const signature = rulings.map((item) => `${item.criterionId}:${item.status}`).join(",");
  const previous = useRef(signature);
  const [changed, setChanged] = useState<string[]>([]);
  useEffect(() => {
    if (previous.current === signature) return;
    const before = new Map(previous.current.split(",").filter(Boolean).map((pair) => {
      const at = pair.lastIndexOf(":");
      return [pair.slice(0, at), pair.slice(at + 1)] as const;
    }));
    const moved = rulings.filter((item) => before.get(item.criterionId) !== item.status)
      .map((item) => item.criterionId);
    previous.current = signature;
    if (!moved.length) return;
    setChanged(moved);
    const timer = window.setTimeout(() => setChanged([]), 1400);
    return () => window.clearTimeout(timer);
  }, [signature, rulings]);

  const headline = !criteria.length
    ? "The Task Framer is writing the acceptance criteria"
    : !settled
      ? "No rulings yet — the Observer files one per criterion, every round"
      : challenged === 0
        ? `Every criterion verified. ${verified} of ${criteria.length} checked against real evidence.`
        : `${challenged} of ${criteria.length} criteria still contested by the Observer`;

  return <details className={`verdicts ${thin ? "one-line" : ""}`} open={!thin && challenged > 0}>
    <summary>
      <span className="verdict-count">
        {criteria.length > 0 && <b className={verified === criteria.length ? "met" : undefined}>{verified}</b>}
        <span>{criteria.length === 0
          ? "no criteria yet"
          : thin && challenged > 0
            ? `verified, ${challenged} contested`
            : `of ${criteria.length} verified`}</span>
      </span>
      {criteria.length > 0 && <span className="verdict-marks" aria-hidden="true">
        {criteria.map((criterion) => {
          const ruling = byId.get(criterion.id);
          const moved = ruling ? changed.includes(criterion.id) : false;
          return <span key={criterion.id}
            className={`mark ${ruling ? VERDICT_CLASS[ruling.status] : "unverified"} ${moved ? "flash" : ""}`}
            title={`${criterion.id}: ${ruling ? VERDICT_WORD[ruling.status] : "not yet ruled on"}`} />;
        })}
      </span>}
      <span className="verdict-chevron" aria-hidden="true" />
    </summary>

    <div className="verdict-panel">
      <p className="verdict-panel-note">{headline}</p>
      {criteria.length > 0
        ? <div className="criteria">
          {criteria.map((criterion) => {
            const ruling = byId.get(criterion.id);
            return <details className={`criterion ${ruling ? ruling.status : "unverified"}`} key={criterion.id}>
              <summary>
                <span className={`mark ${ruling ? VERDICT_CLASS[ruling.status] : "unverified"}`} aria-hidden="true" />
                <span>
                  <span className="criterion-id">{criterion.id}</span>
                  <span className="criterion-text">{criterion.description}</span>
                  {ruling
                    ? <span className={`criterion-ruling ${VERDICT_CLASS[ruling.status]}`}>
                      {VERDICT_WORD[ruling.status]}<em>round {ruling.round}</em>
                    </span>
                    : <span className="criterion-ruling unverified"><em>not yet ruled on</em></span>}
                </span>
              </summary>
              {ruling?.rationale && <p className="criterion-why">{ruling.rationale}</p>}
              <p className="criterion-check">Checked by: {criterion.verification}</p>
            </details>;
          })}
        </div>
        : <p className="criterion-check">
          The criteria become the contract both agents answer to, and the thing the Observer rules on.
        </p>}
      {children}
    </div>
  </details>;
}
