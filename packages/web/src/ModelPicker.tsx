import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderView, RoleModel } from "./types";

function tokens(value?: number) {
  if (!value) return "unknown";
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
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open]);

  const current = props.providers.find((item) => item.id === props.value.providerID);
  const provider = props.providers.find((item) => item.id === providerID) ?? current ?? props.providers[0];
  const info = current?.modelMetadata?.[props.value.modelID];
  const models = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return provider?.models ?? [];
    return (provider?.models ?? []).filter((item) => {
      const name = provider?.modelMetadata?.[item]?.name?.toLowerCase() ?? "";
      return item.toLowerCase().includes(query) || name.includes(query);
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
    <div className="model-line">
      <span className="label">{props.label}</span>
      <span>
        <b>{info?.name ?? current?.name ?? "No model chosen"}</b>
        <code>{props.value.modelID}</code>
      </span>
      <span style={{ display: "grid", justifyItems: "end", gap: 3 }}>
        <span className="limits">{tokens(info?.contextWindow)} context · {tokens(info?.maxOutputTokens)} out</span>
        <button type="button" disabled={props.disabled} onClick={show}>Change</button>
      </span>
    </div>

    {open && <div className="scrim" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) setOpen(false);
    }}>
      <section className="dialog" ref={dialog} role="dialog" aria-modal="true" aria-label={`Choose a model for ${props.label}`}>
        <header className="dialog-head">
          <div>
            <h2>Choose a model</h2>
            <p>{props.label}</p>
          </div>
          <button type="button" className="quiet" onClick={() => setOpen(false)}>Close</button>
        </header>
        <div className="dialog-body">
          <div className="picker">
            <div className="picker-providers" role="group" aria-label="Providers">
              {props.providers.map((item) => <button type="button" key={item.id}
                aria-pressed={provider?.id === item.id} disabled={!item.configured}
                onClick={() => { setProviderID(item.id); setSearch(""); }}>
                <b>{item.name}</b>
                <span className="mono">{item.configured ? `${item.models.length} models` : "no key"}</span>
              </button>)}
            </div>
            <div className="picker-models">
              <input type="search" autoFocus value={search} aria-label="Search models"
                onChange={(event) => setSearch(event.target.value)}
                placeholder={provider ? `Search ${provider.models.length} ${provider.name} models` : "Search models"} />
              <div className="picker-list">
                {models.map((item) => {
                  const meta = provider?.modelMetadata?.[item];
                  return <button type="button" key={item}
                    aria-pressed={item === props.value.modelID && provider?.id === props.value.providerID}
                    onClick={() => choose(item)}>
                    <b>{meta?.name ?? item}</b>
                    <span className="mono">{tokens(meta?.contextWindow)}</span>
                    {meta?.name && <code>{item}</code>}
                  </button>;
                })}
                {!models.length && <p className="faint" style={{ fontSize: 13.5, padding: "8px 10px" }}>
                  {provider ? `No ${provider.name} model matches "${search}".` : "Connect a provider first."}
                </p>}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>}
  </>;
}
