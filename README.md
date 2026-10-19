# OPC Delivery Desk

An independent MVP for coordinating delivery work between enterprise requesters and OPCs / small teams. It manages recruitment, team price confirmation, milestone planning, submissions, acceptance, a settlement ledger, and explicit order closeout.

The application is independently implemented and runs separately from AiToEarn. AiToEarn was a reference for product and deployment architecture; this repository does not bundle or depend on its source code.

## What it does

- Requesters publish work orders and recruit workers.
- Requesters select a team and propose a total price; the selected team confirms it.
- Requesters define structured delivery milestones: title, due date, deliverable and acceptance criteria, and stage amount.
- Workers submit evidence for each milestone. Requesters accept it or request revisions with a reason.
- After every milestone is accepted, the order enters **Ready to close**. The requester reviews the whole delivery and explicitly closes the order.
- SQLite stores accounts, orders, applications, milestones, and timestamped events. Redis stores login sessions and account lookup caches.
- An AI requirement assistant can structure a short brief into suggested deliverables, milestones, and questions. Without an API key, the app uses its offline rule-based assistant.

The settlement ledger is a record for the demo. This MVP does not hold, escrow, or transfer money and does not resolve legal disputes.

## Run with Docker Desktop

Requirements: Docker Desktop with Docker Engine and Docker Compose running. The first build needs access to Docker Hub to pull `node:24-alpine` and `redis:7-alpine`.

In PowerShell, from this folder:

```powershell
Copy-Item .env.example .env
# Optional: edit .env and set OPC_AI_API_KEY for the DeepSeek assistant.
.\run-opc-demo.ps1
```

Open `http://localhost:8080/`. Register requester and worker accounts at `/register`; log in at `/login`. To use a different local port, set it in PowerShell before starting, for example `$env:OPC_PORT = '8081'`.

To stop the app while preserving its SQLite and Redis volumes:

```powershell
.\stop-opc-demo.ps1
```

To remove the demo and its persistent volumes, run `docker compose -p opc-delivery-desk -f docker-compose.yml down -v`. This permanently deletes local demo data.

## Architecture

- `server.mjs`: Node.js HTTP API, authentication, business workflow, and static app hosting.
- SQLite: authoritative store at `/data/opc-demo.sqlite` in the container.
- Redis: login sessions and account caches.
- `docker-compose.yml`: isolated app and Redis services with persistent named volumes.
- `public/`: requester, worker, registration, login, and admin interfaces.

## AI configuration

The optional assistant uses the OpenAI-compatible DeepSeek chat completions endpoint. Set these values in `.env`:

```dotenv
OPC_AI_API_KEY=your-key
OPC_AI_BASE_URL=https://api.deepseek.com/chat/completions
OPC_AI_MODEL=deepseek-chat
```

Never commit `.env` or API keys. `.gitignore` excludes local secrets and database files.

## License

MIT. See [LICENSE](LICENSE).