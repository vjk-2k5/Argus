import { useMutation } from "@tanstack/react-query";
import { recommendModels } from "./api";
import type { AgentRole, ProviderView, RecommendationView, RoleModel, RoleRecommendationView } from "./types";

const ROLES: Array<{ id: AgentRole; label: string }> = [
  { id: "framer", label: "Task Framer" },
  { id: "answerer", label: "Answer Agent" },
  { id: "observer", label: "Observer" },
];

function percent(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function roleValue(rec: RoleRecommendationView): RoleModel {
  return { providerID: rec.providerID, modelID: rec.modelID, options: {} };
}

export function RouterRecommend(props: {
  problem: string;
  providers: ProviderView[];
  onApply: (role: AgentRole, value: RoleModel) => void;
  onApplyAll: (roles: Record<AgentRole, RoleModel>) => void;
}) {
  const recommend = useMutation({ mutationFn: recommendModels });

  const nameOf = (providerID: string, modelID: string) => {
    const provider = props.providers.find((item) => item.id === providerID);
    return provider?.modelMetadata?.[modelID]?.name ?? modelID;
  };

  const applyAll = (data: RecommendationView) => {
    props.onApplyAll({
      framer: roleValue(data.roles.framer),
      answerer: roleValue(data.roles.answerer),
      observer: roleValue(data.roles.observer),
    });
  };

  return <div className="jev-recs">
    <div className="plain-row" style={{ paddingTop: 0, borderTop: 0 }}>
      <span className="faint" style={{ fontSize: 13.5 }}>
        Jev reads your problem and recommends a model per role from the model catalog (OpenRouter IDs).
      </span>
      <button type="button" disabled={recommend.isPending || !props.problem.trim()}
        onClick={() => recommend.mutate(props.problem)}>
        {recommend.isPending ? "Asking Jev…" : recommend.data ? "Ask Jev again" : "Recommend with Jev"}
      </button>
    </div>

    {recommend.error && <p className="problem" role="alert" style={{ fontSize: 13 }}>
      <b>Jev could not recommend.</b> {recommend.error instanceof Error ? recommend.error.message : "Request failed"}
    </p>}

      {recommend.data && <>
      {ROLES.map(({ id, label }) => {
        const rec = recommend.data.roles[id];
        return <div className="model-line" key={id}>
          <span className="label">{label}</span>
          <span>
            <b>{nameOf(rec.providerID, rec.modelID)}</b>
            <code>{rec.modelID}</code>
            {rec.description && <span className="faint" style={{ fontSize: 12.5 }}>{rec.description}</span>}
          </span>
          <span style={{ display: "grid", justifyItems: "end", gap: 3 }}>
            <span className="limits">{percent(rec.probability)} · {percent(rec.confidence)} confidence</span>
            <button type="button" onClick={() => props.onApply(id, roleValue(rec))}>Use</button>
          </span>
        </div>;
      })}
      <div className="plain-row">
        <span className="faint" style={{ fontSize: 12.5 }}>
          {recommend.data.model} weighed {recommend.data.candidatesConsidered} catalog models
          {recommend.data.truncated ? " (catalog capped)" : ""}. Picks apply as OpenRouter models — nothing changes until you apply one.
        </span>
        <button type="button" className="link" onClick={() => applyAll(recommend.data!)}>Use all three</button>
      </div>
    </>}
  </div>;
}
