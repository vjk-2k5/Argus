# Argus

Argus is a stateful multi-agent debate framework for adversarial exploration. A Task Framer turns a vague problem into an approvable research task, then an Answer Agent and an Observer/Questioner debate it round by round until every acceptance criterion is verified or the round limit is reached.

- **Phase 1** — multi-agent debate over model knowledge: Task Framer, Answer Agent, Observer/Questioner, user approval, persistent sessions, streamed reasoning, pause/resume, automatic context compaction.
- **Phase 2** — the agents act on the world: every agent gets a full toolset (files, shell, web, tasks) inside a per-session workspace, with live tool-call streaming into the UI.
- **Phase 3** — subagents (planned).

## Run locally

1. Install Bun 1.3.14.
2. Copy `.env.example` to `.env` and configure at least one provider key.
3. Run `bun install`.
4. In separate terminals run `bun run dev:server` and `bun run dev:web`.
5. Open `http://localhost:5173`.

Data is stored in `argus.db` by default. Upgrading from Phase 1 is automatic: the `tool_access` and `workspace` columns are added in place and existing sessions are preserved.

## Phase 2: agent tools

Every agent role (framer, answerer, observer, finalizer) receives tools. Tool access is chosen per session and can be changed at any time before the session ends.

| Access | Tools | Notes |
| --- | --- | --- |
| `full` (default) | `read` `write` `edit` `apply_patch` `glob` `grep` `list` `bash` `websearch` `webfetch` `question` | Agents can change the workspace and run shell commands. |
| `read` | `read` `glob` `grep` `list` `websearch` `webfetch` `question` | Inspection only; no file changes, no shell. |
| `off` | none | Phase 1 behaviour: reasoning from model knowledge only. |

### Design notes

Behaviour ported from opencode's tool layer where it was measurably better:

- **`edit` uses a 9-stage fallback chain** instead of requiring a byte-exact match. If `oldString` is not found verbatim, progressively relaxed strategies run in order: line-trimmed, block anchors (Levenshtein-scored), whitespace-normalized, indentation-flexible, escape-normalized, trimmed-boundary, context-aware, multi-occurrence. A disproportionate-match guard refuses to replace a span far larger than the requested text, and CRLF line endings plus any byte-order mark are preserved. The reply names the strategy that landed so a fuzzy match is never silent.
- **`read` protects the context window.** Output is wrapped in a `<path>` / `<type>` / `<content>` envelope, individual lines are truncated at 2000 characters, total output is capped at 50 KB, and the reply states the exact `offset` to continue from. Directories are readable, missing paths get "did you mean" suggestions, and binary detection uses an extension list plus a non-printable-byte heuristic.
- **`apply_patch`** applies a `*** Begin Patch` envelope with Add, Update, Move, and Delete operations. Every hunk is verified before anything is written, so a patch either lands completely or changes nothing — the right primitive for a multi-file change.
- **`bash` is confined by a path audit.** Beyond the destructive-command deny list, every path token in the command is resolved against the workspace boundary, including the static prefix of a glob, so the shell cannot become the one way out of the sandbox that every other tool respects.
- **`websearch` uses Exa's public MCP endpoint** (`https://mcp.exa.ai/mcp`), which needs no API key and returns each result's full page content, not a snippet. Set `EXA_API_KEY` to lift the free-tier limits. Tavily, Brave, and a keyless DuckDuckGo path remain available as fallbacks, tried in order, so the tool never hard-fails.
- **`webfetch`** returns markdown, text, or raw HTML, checks `content-length` before reading, and retries Cloudflare bot challenges with an honest user agent.

### Session workspaces

Each session gets its own directory named after the session, under `ARGUS_SESSIONS_DIR` (default `C:\Projects\Argus_Sessions` on Windows, `../Argus_Sessions` elsewhere):

```
C:\Projects\Argus_Sessions\compute-40-digits-of-sqrt2-1a2b3c4d\sqrt2.py
```

Every relative path in a tool call resolves inside that directory, and the server rejects any path that escapes it. Dependency and build directories (`node_modules`, `.git`, `dist`, …) are skipped by `glob`, `grep`, and `list`.

When starting an exploration you can instead point the agents at an existing directory — for example a folder that already holds the files they should work on — using the **Working directory** field in Run settings. That folder becomes the session workspace and the boundary every tool respects. Leave the field blank and Argus creates a fresh folder for the session as above, so material carried in from a previous run is reused only when you ask for it. A blank path is not created; a path that already exists as a file is rejected.

### Shell safety

`bash` runs in the session workspace and is filtered by a deny list before it executes. Refused commands come back to the model as an explanation, not a crash, so it can adapt. Blocked: recursive deletes of roots, drives, homes, and system paths; drive formatting and raw disk writes; shutdown and host reconfiguration; destructive SQL; piping downloads into a shell; dynamic code evaluation; registry, permission, and execution-policy tampering; fork bombs.

This is a deny list, not a container. A determined command can still reach outside the workspace, so run Argus on a machine where that is acceptable.

On Windows the shell is PowerShell 7 (`pwsh`) when available, otherwise Windows PowerShell 5.1, where `&&` and `||` are not valid statement separators. The tool description tells the model which shell it has.

### Web tools

`websearch` leads with Exa's public MCP endpoint, which works without a key and returns full page content alongside each result, so agents can cite a source without a second call. Set `ARGUS_SEARCH_PROVIDER` to `tavily` (with `ARGUS_TAVILY_API_KEY`) or `brave` (with `ARGUS_BRAVE_API_KEY`) to lead with a keyed provider instead; `duckduckgo` and Exa stay in the fallback chain. `webfetch` fetches a URL as markdown, text, or HTML, and blocks non-HTTP schemes.

### Observability

Tool calls stream to the browser over SSE (`tool.updated`), are persisted in the message's `metadata.toolCalls`, and are rendered as collapsible blocks under each agent message. A compact tool log is replayed into the next turn's context and preserved through compaction, so later rounds know what was actually executed and can cite exact paths, commands, and URLs.

### Providers

Six providers ship in the registry: `openai`, `anthropic`, `google`, `openrouter`, `openai-compatible`, and `bedrock`. Each reads one credential from the environment (or from a key saved through the UI, which takes precedence), and the Model picker lists every model that provider advertises.

`bedrock` targets AWS Bedrock through the Vercel AI SDK's Amazon Bedrock adapter. Set `AWS_BEARER_TOKEN_BEDROCK` to the API key from the Bedrock console (`API keys`) and `AWS_REGION` to the region serving the model; Argus reports the provider as unconfigured until both are present, because Bedrock models are region-scoped. The key is sent as a bearer token, which takes precedence over SigV4, so `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are not needed. Saving the key from the UI verifies it against Bedrock before storing it.

The Model picker is populated live from `ListFoundationModels` and `ListInferenceProfiles`, so it lists what the region actually serves. Both catalogs are merged, which means base model IDs (`anthropic.claude-sonnet-4-5-20250929-v1:0`) appear alongside the cross-region inference profiles that route them (`us.` and `global.` prefixed). Only models that support streaming Converse are offered, since that is the transport Argus uses. An inference profile inherits the output ceiling of the foundation model it routes to, so `ARGUS_MAX_OUTPUT_TOKENS` and the orchestrator's turn bounds still apply. Use "Refresh catalog" after enabling a new model in the Bedrock console; otherwise the cached list (5 minutes) is reused. `BEDROCK_MODEL` pins a default ahead of `ARGUS_BEDROCK_MODELS`, which is the static comma-separated fallback list used only when discovery is unavailable.

## Shell

`bash` runs every command through one shell process per call. On Windows the shell is chosen in order: `ARGUS_SHELL` if set, then PowerShell 7, then Windows PowerShell 5.1, then Git Bash, then `cmd.exe`. On POSIX it is `$SHELL`, falling back to `bash`. The resolved shell is named in the tool description along with syntax guidance for that dialect, because the common failure is a model writing `&&`, `ls`, and `$VAR` into PowerShell. Setting `ARGUS_SHELL` to Git Bash is usually the highest-leverage setting on Windows, since it accepts the POSIX syntax models write by default.

The reader always consumes a command's output to completion. Past the first 60000 characters the remainder is streamed to a file under `ARGUS_TRUNCATION_DIR` and the path is reported in the output, so the agent can `read` or `grep` the rest. Output is never abandoned mid-stream: a child that cannot flush blocks on a full pipe and would never exit, which used to surface as a synthetic `exit -1` for a command that had actually succeeded.

Exit statuses distinguish three outcomes. A command that runs to completion reports its own code. A command terminated by `timeout` or an aborted turn reports no exit status at all, because it never had one; the output says which of the two happened and, for a timeout, suggests retrying with a larger `timeout`. `workdir` takes a path relative to the session workspace, since each call starts a fresh shell and `cd` does not carry over.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARGUS_PORT` | `3001` | Server port |
| `ARGUS_DATABASE_PATH` | `./argus.db` | SQLite database |
| `ARGUS_SESSIONS_DIR` | `C:\Projects\Argus_Sessions` (Windows) | Root for per-session workspaces |
| `ARGUS_SHELL` | auto-detected | Shell for the `bash` tool. On Windows the chain is PowerShell 7, Windows PowerShell 5.1, Git Bash, `cmd.exe`. Point it at Git Bash to accept POSIX syntax. |
| `ARGUS_GIT_BASH_PATH` | – | Explicit `bash.exe` path, skipping Git-for-Windows discovery |
| `ARGUS_TRUNCATION_DIR` | `$ARGUS_SESSIONS_DIR/.truncations` | Where oversized shell output is written |
| `ARGUS_MAX_STEPS` | unbounded | Optional ceiling on model steps per turn, including tool calls. Unset means no ceiling. |
| `ARGUS_CONTEXT_WINDOW` | `128000` | Fallback context window when a provider does not report one |
| `ARGUS_COMPACTION_RESERVED_TOKENS` | `20000` | Tokens reserved for the final report during compaction |
| `ARGUS_MAX_OUTPUT_TOKENS` | unbounded | Optional output token ceiling. Unset sends no `maxOutputTokens`, so the provider applies the model's own maximum. |
| `ARGUS_MAX_CONTINUATIONS` | `2` | How many times a turn cut off by the output or step limit is resumed in place before the round is treated as settled |
| `ARGUS_SEARCH_PROVIDER` | `exa` | `exa` (keyless), `duckduckgo`, `tavily`, or `brave` |
| `EXA_API_KEY` | – | Optional; lifts Exa's free-tier limits |
| `ARGUS_TAVILY_API_KEY` / `ARGUS_BRAVE_API_KEY` | – | Search credentials |

## Persistence

Both agents run under a shared persistence doctrine, because a run that ends in a shrug is worthless regardless of how well it was verified.

"You can't do it" is never available as an answer while a route remains untried. `open`, `unknown`, `inconclusive`, and "would need an experiment I cannot run" are treated as facts about the *current route*, never about the problem, and neither agent may hand one back as its conclusion. When an agent believes it has hit a wall, the doctrine requires it to enumerate the assumptions its route rests on, find the one carrying the load, and attack from an angle it has not already exhausted: weaken the claim until it still meets the criterion, solve a special case and generalize, reformulate in another formalism, take an approximation with an explicit error bound, build the counterexample that reframes what must be shown, or reduce to something settleable. Re-running a failed route or rewording the same argument does not count as trying differently. Agents keep an explicit ledger of routes tried and what each established, so a new round resumes from it instead of rediscovering it.

Output and step limits are treated as search budgets, not permission to stop early. `ARGUS_MAX_OUTPUT_TOKENS` and `ARGUS_MAX_STEPS` are unset by default for exactly this reason.

The doctrine is explicitly bounded so it cannot become dishonesty: **it governs the search, never the claims.** An agent may not convert an unresolved question into a resolved one by asserting it more confidently. Keep attacking through new routes and let the evidence decide. Honest reporting of residual uncertainty remains the Final Agent's job at the end of a run, once the routes are genuinely spent.

## Closure is earned, not declared

A run ends when the Observer rules every framed acceptance criterion MET with its own executed evidence, or when the round limit is reached. Nothing else ends it.

The Observer's `decision: "complete"` is checked against the frame before it is honoured. If any criterion is `not_met`, or the Observer never ruled on it at all, the closure is rejected and the debate continues with an explicit note saying which criteria blocked it. This makes "the problem is open", "inconclusive", or "would need a real experiment" unusable as a way to stop early, because the round limit already provides an honest exit. Silence is not a pass: a criterion omitted from the control block counts as unmet.

While work remains, the Observer is required to address the **path**, not the gap. For each unmet criterion it states whether the approach taken is correct, wrong, or merely unfinished, and which path would actually reach the criterion. `nextFocus` carries those directions as short imperatives about method and emphasis ("pivot to the algebraic route", "carry the boundary case through to the same conclusion", "abandon that framing, it cannot reach the criterion"). Restatements of the gap ("investigate further", "gather more evidence"), questions back to the user, and promises to look at something later are rejected by instruction.

## Evidence rules

Argus agents are instructed to treat tool output as evidence they must actually obtain: never claim a file was read, a command was run, or a page was fetched unless that call appears in the session, and name the exact path, command, or URL behind every material claim. The Observer is required to verify the Answer Agent's claims with its own tool calls before marking a criterion MET. Web access reaches only what a public search engine and ordinary HTTP fetch can reach, so paywalled literature, peer review, and physical experiments remain out of scope and must be framed as unperformed follow-ups.
