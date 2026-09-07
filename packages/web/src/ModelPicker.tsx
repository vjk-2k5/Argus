import { useMemo, useState } from "react";
import type { ProviderView, RoleModel } from "./types";

function tokens(value?: number) {
  if (!value) return "Unknown";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return value.toLocaleString();
}

export function ModelPicker(props: {
  label: string;
  value: RoleModel;
  providers: ProviderView[];
  disabled?: boolean;
  onChange: (value: RoleModel) => void;
}) {
  const [open, setOpen] = useState(false);
  const [providerID, setProviderID] = useState(props.value.providerID);
  const [search, setSearch] = useState("");
  const current = props.providers.find((item) => item.id === props.value.providerID);
  const provider = props.providers.find((item) => item.id === providerID) ?? current ?? props.providers[0];
  const currentMetadata = current?.modelMetadata?.[props.value.modelID];
  const models = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return provider?.models ?? [];
    return (provider?.models ?? []).filter((item) => {
      const metadata = provider?.modelMetadata?.[item];
      return item.toLowerCase().includes(query) || metadata?.name?.toLowerCase().includes(query);
    });
  }, [provider, search]);
  const show = () => {
    setProviderID(props.value.providerID);
    setSearch("");
    setOpen(true);
  };
  const choose = (modelID: string) => {
    if (!provider) return;
    props.onChange({ providerID: provider.id, modelID, options: props.value.options ?? {} });
    setOpen(false);
  };

  return <>
    <div className="model-picker-card">
      <div><span className="model-role">{props.label}</span>
        <strong>{currentMetadata?.name ?? current?.name ?? props.value.providerID}</strong>
        <code>{props.value.modelID || "No model selected"}</code>
        <span className="model-limits">
          <small>Context {tokens(currentMetadata?.contextWindow)}</small>
          <small>Max output {tokens(currentMetadata?.maxOutputTokens)}</small>
        </span></div>
      <button type="button" disabled={props.disabled} onClick={show}>Choose model</button>
    </div>
    {open && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) setOpen(false);
    }}>
      <section className="modal model-modal" role="dialog" aria-modal="true" aria-label={`Choose ${props.label} model`}>
        <header className="modal-header"><div><h2>Choose model</h2><p className="muted">{props.label}</p></div>
          <button type="button" onClick={() => setOpen(false)}>Close</button></header>
        <div className="model-modal-body">
          <nav className="provider-list" aria-label="Providers">
            {props.providers.map((item) => <button type="button" key={item.id}
              className={provider?.id === item.id ? "active" : ""}
              disabled={!item.configured}
              onClick={() => { setProviderID(item.id); setSearch(""); }}>
              <span>{item.name}</span><small>{item.configured ? `${item.models.length} models` : "Not connected"}</small>
            </button>)}
          </nav>
          <div className="model-results">
            <input autoFocus type="search" value={search} onChange={(event) => setSearch(event.target.value)}
              placeholder={`Search ${provider?.models.length ?? 0} models…`} />
            <div className="model-list">
              {models.map((item) => {
                const metadata = provider?.modelMetadata?.[item];
                return <button type="button" key={item}
                  className={item === props.value.modelID && provider?.id === props.value.providerID ? "selected" : ""}
                  onClick={() => choose(item)}>
                  <span>{metadata?.name ?? item}</span>
                  {metadata?.name && <code>{item}</code>}
                  <small>Context {tokens(metadata?.contextWindow)} · Max output {tokens(metadata?.maxOutputTokens)}</small>
                </button>;
              })}
              {models.length === 0 && <p className="empty">No models match this search.</p>}
            </div>
          </div>
        </div>
      </section>
    </div>}
  </>;
}
