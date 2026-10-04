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
  bedrock: "https://console.aws.amazon.com/bedrock/home#/api-keys",
};

function message(error: unknown) {
  return error instanceof Error ? error.message : "The provider request failed.";
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
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, onClose]);

  const apply = (result: ProviderResponseView) => {
    client.setQueryData(["providers"], result);
    setKey("");
    setEditing(undefined);
  };
  const connect = useMutation({ mutationFn: (input: { id: ProviderId; key: string }) => connectProvider(input.id, input.key), onSuccess: apply });
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
  const list = providers.data?.providers ?? [];

  return <div className="scrim" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target) onClose();
  }}>
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="providers-title">
      <header className="dialog-head">
        <div>
          <h2 id="providers-title">API keys</h2>
          <p>Argus needs at least one connected provider before a debate can run.</p>
        </div>
        <button type="button" className="quiet" onClick={onClose}>Close</button>
      </header>

      <div className="dialog-body">
        <p className="caution">
          Keys are sent only to the Argus server on this machine, stored outside this project, and never handed back to the browser.
        </p>
        {providers.isLoading && <p className="faint" style={{ fontSize: 13.5 }}>Reading model catalogs…</p>}
        {error && <p className="problem" role="alert">{message(error)}</p>}

        <div className="credential-list">
          {list.map((provider) => {
            const discovers = provider.modelSource === "api";
            const source = provider.credentialSource === "stored" ? "key stored by Argus"
              : provider.credentialSource === "environment" ? "key read from .env" : "no key";
            return <article className="credential" key={provider.id}>
              <div className="credential-head">
                <b>{provider.name}</b>
                <span className="state">
                  <span className={`dot ${provider.configured ? "done" : ""}`} aria-hidden="true" />
                  {provider.configured ? "connected" : "not connected"}
                </span>
              </div>
              <div className="credential-facts">
                <span>{source}</span>
                <span>{provider.models.length.toLocaleString()} models</span>
                <span>{provider.modelSource === "api" ? "live catalog" : "built-in catalog"}</span>
              </div>
              {provider.modelError && <p className="problem" style={{ fontSize: 13 }}>
                The catalog could not be refreshed. {provider.modelError}
              </p>}
              <div className="credential-actions">
                <button type="button" onClick={() => { setEditing(provider.id); setKey(""); }}>
                  {provider.configured ? "Replace key" : "Connect"}
                </button>
                {discovers && <button type="button" disabled={!provider.configured || refresh.isPending}
                  onClick={() => refresh.mutate(provider.id)}>
                  {refresh.isPending && refresh.variables === provider.id ? "Refreshing…" : "Refresh catalog"}
                </button>}
                {provider.credentialSource === "stored" && <button type="button" className="danger"
                  disabled={disconnect.isPending} onClick={() => disconnect.mutate(provider.id)}>Disconnect</button>}
                {keyLinks[provider.id] && <a href={keyLinks[provider.id]} target="_blank" rel="noreferrer">Get a key</a>}
              </div>
              {editing === provider.id && <form className="credential-form" onSubmit={(event) => submit(event, provider.id)}>
                <input type="password" autoComplete="new-password" autoFocus value={key} required
                  aria-label={`${provider.name} API key`}
                  onChange={(event) => setKey(event.target.value)} placeholder={`Paste the ${provider.name} key`} />
                <button className="primary" type="submit" disabled={connect.isPending || !key.trim()}>
                  {connect.isPending ? "Checking…" : "Save key"}
                </button>
              </form>}
            </article>;
          })}
        </div>
      </div>
    </section>
  </div>;
}
