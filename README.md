# Argus

Argus is a stateful multi-agent debate framework for adversarial exploration. Phase 1 runs a Task Framer, Answer Agent, and Observer/Questioner over model knowledge, with user approval before the debate, persistent sessions, streamed model reasoning when available, pause/resume, and automatic context compaction.

## Run locally

1. Install Bun 1.3.14.
2. Copy `.env.example` to `.env` and configure at least one provider key.
3. Run `bun install`.
4. In separate terminals run `bun run dev:server` and `bun run dev:web`.
5. Open `http://localhost:5173`.

Data is stored in `argus.db` by default. Phase 1 does not verify external claims or citations; web research and file/code tools are intentionally deferred.
