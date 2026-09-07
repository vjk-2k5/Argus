import { FormEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProviderId } from "@argus/shared";
import { connectProvider, disconnectProvider, getProviders, refreshProvider } from "./api";
import type { ProviderResponseView } from "./types";

const keyLinks: Partial<Record<ProviderId, string>> = {
  openrouter: "https://openrouter.ai/settings/keys",
  google: "https://aistudio.google.com/app/apikey",
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
};

function message(error: unknown) {
  return error instanceof Error ? error.message : "Provider request failed";
}

export function ProviderSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const providers = useQuery({ queryKey: ["providers"], queryFn: getProviders, enabled: open });
  const [editing, setEditing] = useState<ProviderId>();
  const [key, setKey] = useState("");
  useEffect(() => {
    if (open) return;
    setEditing(undefined);
    setKey("");
  }, [open]);
  const apply = (result: ProviderResponseView) => {
    client.setQueryData(["providers"], result);
    setKey("");
    setEditing(undefined);
  };
  const connect = useMutation({
    mutationFn: (input: { id: ProviderId; key: string }) => connectProvider(input.id, input.key),
    onSuccess: apply,
  });
  const disconnect = useMutation({ mutationFn: disconnectProvider, onSuccess: apply });
  const refresh = useMutation({
    mutationFn: refreshProvider,
    onSuccess: (result) => client.setQueryData(["providers"], result),
  });
  if (!open) return null;
  const submit = (event: FormEvent, id: ProviderId) => {
    event.preventDefault();
    if (key.trim()) connect.mutate({ id, key });
  };
  const error = connect.error ?? disconnect.error ?? refresh.error ?? providers.error;

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target) onClose();
  }}>
    <section className="modal provider-modal" role="dialog" aria-modal="true" aria-labelledby="provider-title">
      <header className="modal-header"><div><h2 id="provider-title">Providers</h2>
        <p className="muted">Connect API keys and refresh live model catalogs.</p></div>
        <button type="button" onClick={onClose} aria-label="Close provider settings">Close</button>
      </header>
      <p className="security-note">Keys go only to the local Argus server, are stored outside this project, and are never returned to the browser.</p>
      {providers.isLoading && <p className="muted">Discovering provider models…</p>}
      {error && <p className="error">{message(error)}</p>}
      <div className="provider-cards">
        {providers.data?.providers.map((provider) => {
          const discovers = provider.id === "openrouter" || provider.id === "google";
          return <article className="provider-card" key={provider.id}>
            <header><strong>{provider.name}</strong>
              <span className={`badge ${provider.configured ? "live" : ""}`}>{provider.configured ? "connected" : "not connected"}</span></header>
            <p className="provider-source">{provider.credentialSource === "stored" ? "Stored by Argus" : provider.credentialSource === "environment" ? "Loaded from .env" : "No API key"}</p>
            <p>{provider.models.length.toLocaleString()} models · {provider.modelSource === "api" ? "live catalog" : "fallback catalog"}</p>
            {provider.modelError && <p className="warning">{provider.modelError}</p>}
            <div className="row">
              <button type="button" onClick={() => { setEditing(provider.id); setKey(""); }}>{provider.configured ? "Replace key" : "Connect"}</button>
              {provider.credentialSource === "stored" && <button type="button" className="danger" disabled={disconnect.isPending}
                onClick={() => disconnect.mutate(provider.id)}>Disconnect</button>}
              {discovers && <button type="button" disabled={!provider.configured || refresh.isPending}
                onClick={() => refresh.mutate(provider.id)}>Refresh</button>}
              {keyLinks[provider.id] && <a href={keyLinks[provider.id]} target="_blank" rel="noreferrer">Get key</a>}
            </div>
            {editing === provider.id && <form className="provider-key-form" onSubmit={(event) => submit(event, provider.id)}>
              <input type="password" autoComplete="new-password" autoFocus value={key}
                onChange={(event) => setKey(event.target.value)} placeholder={`${provider.name} API key`} required />
              <button className="primary" type="submit" disabled={connect.isPending || !key.trim()}>
                {connect.isPending ? "Verifying…" : "Save key"}
              </button>
              <button type="button" onClick={() => { setEditing(undefined); setKey(""); }}>Cancel</button>
            </form>}
          </article>;
        })}
      </div>
    </section>
  </div>;
}
