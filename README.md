# SamIsip

SamIsip is a local-first collaboration room where humans and configurable AI models work in one persistent discussion. One room can use several local LLMs running on different computers, OpenAI, Anthropic, and other compatible endpoints at the same time. People decide when models participate by mentioning `@ai-name` or `@all-ai`, while per-room FIFO execution keeps multi-model work ordered and understandable.

Rooms can export an AI-written Markdown summary at any time. The user chooses which ready AI participant acts as the summary author, and the downloaded `.md` file records the author, generation time, message count, and an explicit verification notice.

## What is included

- Human identities, project rooms, members, AI participants, messages, and jobs persisted in SQLite.
- OpenAI-compatible and Anthropic-compatible provider adapters with independent base URLs, model names, and server-side credentials for every AI participant.
- Explicit mention routing for a named model or `@all-ai`.
- Sequential, resumable FIFO model jobs per room with concurrent execution across rooms.
- Server-Sent Events that refresh the active room without making realtime delivery authoritative.
- Intelligent context memory: recent verbatim turns, cited extractive digests, FTS5 retrieval, and one bounded model-requested archive search.
- AI discussion-summary export to Markdown with a selectable room participant.
- Keyless loopback and private LAN model support, explicitly allowlisted keyless HTTPS tunnels for cloud deployments, and configurable CORS for split-origin development.
- LAN-ready app binding so other people on the same trusted network can join from their browsers.
- A built-in mock provider for testing chat and summary downloads without a cloud account.

## Stack

- React 19, TypeScript, Vite, and Tailwind CSS 4.
- Express 5 and TypeScript.
- Node's built-in `node:sqlite` module with SQLite FTS5.
- Native `fetch` provider calls; no provider SDK is required.

Node.js 22.5 or newer is required because the server uses `node:sqlite`.

## Start locally

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:5173`. The Express API runs on `http://localhost:8787` and stores local data in `data/samisip.sqlite` by default. Both development servers listen on the network, so another person on the same trusted LAN can open `http://<samisip-computer-ip>:5173` and choose their own identity.

To use a cloud model, add its key to `.env`, restart the API, and add the model in the room details panel. The model form stores only the environment-variable name; the key value never reaches the browser or SQLite.

## Test locally without an API key

Run the included deterministic provider in a second terminal:

```bash
npm run mock:provider
```

It listens on `http://127.0.0.1:8788/v1`. In SamIsip:

1. Open **Room details** and select **Add model**.
2. Select **Fill local test model**.
3. Submit the model form.
4. Mention `@ai-local` to verify a normal model turn.
5. In **AI summary export**, choose **Local model** and select **Download .md summary**.

The downloaded fixture is a real Markdown response passing through the same server-side provider, context, formatting, and download path used by other models. It is meant for local verification, not production inference.

## Model connections

Provider calls originate from Express, not the browser. This server-side proxy removes the usual browser-to-local-model CORS problem and keeps credentials out of client code.

Every AI participant has an independent provider style, base URL, model name, and optional key environment variable. Select **Add model** once for every endpoint and give each participant a unique `ai-...` username. This is what lets a room mix, for example, two Ollama computers, one LM Studio computer, OpenAI, and Anthropic. Mention one username for a targeted turn or `@all-ai` to queue every enabled participant.

### OpenAI, Anthropic, and compatible APIs

The built-in defaults are:

| Service | Provider style | Base URL | Key env |
| --- | --- | --- | --- |
| OpenAI | OpenAI style | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| Anthropic | Anthropic style | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` |

Compatible services work by replacing the base URL and model. An OpenAI-style endpoint must implement `POST /chat/completions`; an Anthropic-style endpoint must implement `POST /messages`. If a remote service needs a credential, put it in the SamIsip server's environment and enter only that environment-variable name in the model form. Secret values never reach the browser or SQLite.

### Local or LAN deployment

When SamIsip and the model runtime are on the same computer, use the runtime's loopback URL. When a model runs on another LAN computer, use that computer's private IP address. **Key env** may be blank for loopback URLs and direct private addresses in `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, or IPv6 unique-local `fc00::/7`.

Common OpenAI-compatible examples:

| Runtime | Typical base URL | Notes |
| --- | --- | --- |
| [Ollama](https://docs.ollama.com/api/openai-compatibility) | `http://localhost:11434/v1` | Use a locally available Ollama model name. |
| [LM Studio](https://lmstudio.ai/docs/developer/openai-compat) | `http://localhost:1234/v1` | Start the local server and use the loaded model identifier. |
| LAN model host | `http://192.168.1.42:11434/v1` | Replace the address and port with the model computer's private LAN endpoint. |
| SamIsip fixture | `http://127.0.0.1:8788/v1` | Use model `samisip-mock`; no download required. |

For each model computer, configure the runtime to listen on its LAN interface and allow only the required port through that computer's firewall. Provider calls originate from Express, so the runtime does not need browser CORS permission. If the runtime requires a token, put it in `.env` under a distinct uppercase name such as `STUDIO_PC_LLM_KEY` and enter that name in the corresponding model form.

For a built production app, run `npm run build && npm start`, then send LAN users to `http://<samisip-computer-ip>:8787`. This is a same-origin deployment and needs no browser CORS change. `SAMISIP_HOST=0.0.0.0` is the default; set it to `127.0.0.1` if the app should be reachable only from its own computer.

### Cloud or VPS deployment with local-model tunnels

A cloud server cannot directly call a model computer's `localhost` or private LAN address. Start a gateway or tunnel such as ngrok on **each computer that hosts a local model**, forwarding the model runtime's HTTP port. Then add the gateway's HTTPS base URL to SamIsip; for an OpenAI-compatible Ollama tunnel this will commonly be the generated HTTPS origin followed by `/v1`.

Prefer a gateway protected by a long random token. Store that token in the cloud server environment and reference its variable in **Key env**. OpenAI-style requests send it as `Authorization: Bearer ...`; Anthropic-style requests send it as `x-api-key`.

If the gateway is intentionally keyless, the cloud administrator must explicitly allow its exact origin before SamIsip will accept it:

```dotenv
KEYLESS_MODEL_ORIGINS=https://first-model.example-tunnel.app,https://second-model.example-tunnel.app
```

Restart SamIsip after changing the environment, then leave **Key env** blank for those model entries. The allowlist compares exact origins—scheme, hostname, and port—while the `/v1` path remains part of the model's Base URL. It does not accept wildcards. Keep tunnel URLs private, use HTTPS, restrict gateway access where possible, and rotate a tunnel URL if it leaks.

## Export a room summary

Open **Room details**, find **AI summary export**, select a configured AI participant, and download the report. Summary generation:

- uses the room's current project brief and layered context memory;
- keeps recent turns verbatim and represents older history through cited digests and exact retrieval;
- asks the chosen model for Overview, Decisions, Open questions, Action items, and Important context sections;
- strips accidental outer code fences and duplicate H1 headings;
- adds deterministic provenance and verification text;
- does not add the generated report to the room transcript.

The complete room transcript remains the source of truth. Exports are point-in-time AI interpretations and should be checked before treating decisions or assignments as authoritative.

The HTTP operation is `POST /api/rooms/:roomId/summary` with `{ "agentId": "..." }`. A successful response uses `text/markdown` and a `.md` filename in `Content-Disposition`.

## Context memory

Long rooms do not send the entire transcript on every model turn. The context manager allocates bounded space to:

1. recent messages in full;
2. deterministic extractive digests of older message ranges, with message IDs and authors;
3. relevant exact messages retrieved from the complete FTS5-indexed transcript.

A model may request one additional exact search by replying only with `[[search-history: concise query]]`. SamIsip performs the bounded lookup and asks that model to answer again. Compression never deletes or replaces the canonical messages.

## CORS and split-origin development

The normal Vite workflow proxies `/api` to Express and needs no browser CORS configuration. If the client and API use different origins, set both sides explicitly:

```dotenv
VITE_API_URL=http://127.0.0.1:8787
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,private-network
```

`CORS_ORIGINS` is a comma-separated allowlist. The `private-network` token accepts browser origins using loopback, RFC 1918 IPv4, or IPv6 unique-local addresses. This fixes split-origin access from another trusted LAN computer without opening access to public origins. Remove the token when LAN browser access is not required. Preflight responses include the methods and headers used by SamIsip, expose `Content-Disposition` for summary filenames, and acknowledge browser private-network requests. `*` is supported for disposable local experiments but should not be used for a shared deployment.

This API CORS layer is separate from local-model compatibility: model calls are already server-to-server and therefore are not subject to browser CORS enforcement.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Express API and production client port |
| `SAMISIP_HOST` | `0.0.0.0` | Network interface for the production/API server; the default permits LAN access |
| `MOCK_PROVIDER_PORT` | `8788` | Built-in local fixture port |
| `DATABASE_PATH` | `data/samisip.sqlite` | SQLite database path |
| `VITE_API_URL` | empty | Optional absolute API origin for the browser |
| `CORS_ORIGINS` | local Vite origins plus `private-network` | Comma-separated browser-origin rules |
| `OPENAI_API_KEY` | empty | Example OpenAI credential |
| `ANTHROPIC_API_KEY` | empty | Example Anthropic credential |
| `KEYLESS_MODEL_ORIGINS` | empty | Exact comma-separated public origins permitted to host keyless model tunnels |
| `MAX_AI_CHAIN_DEPTH` | `3` | Maximum AI-to-AI handoff depth |
| `MAX_CONTEXT_CHARS` | `48000` | Overall context-planning estimate |
| `CONTEXT_RECENT_MESSAGES` | `24` | Maximum recent verbatim turns |
| `CONTEXT_SUMMARY_CHUNK` | `40` | Messages per extractive digest checkpoint |
| `CONTEXT_SUMMARY_MIN_MESSAGES` | `12` | Minimum older tail to checkpoint |
| `MAX_HISTORY_SEARCH_RESULTS` | `12` | Automatic and requested archive result cap |

## Scripts

- `npm run dev`: run React and Express with live reload.
- `npm run dev:api`: run only the API watcher.
- `npm run dev:web`: run only Vite.
- `npm run mock:provider`: run the keyless local provider fixture.
- `npm run build`: type-check and build the production API and client.
- `npm test`: run orchestration, context, export, local-endpoint, and CORS tests.
- `npm start`: serve the built API and React client.

## Current boundaries

SamIsip is a local-first MVP, not yet a production multi-tenant service. It does not currently provide authentication, room-level authorization, encrypted managed secrets, distributed workers, provider usage budgets, or a general endpoint allowlist. `KEYLESS_MODEL_ORIGINS` only controls which public model endpoints may omit a credential; it is not a browser-access control. The `private-network` CORS rule trusts browsers on private address ranges, but CORS is not authentication. Use it only on a trusted LAN. Before exposing SamIsip on a cloud host, put the entire app behind an authenticated reverse proxy, private VPN, or equivalent access control; never publish it anonymously.

## License

Copyright © Fernan de Dios. Released under the [MIT License](LICENSE.MD).
