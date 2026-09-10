# ZuSu Trading

A day-trading automation platform built so that **AI can recommend a trade but can
never authorise one**. Every order passes a deterministic risk engine, every action
is auditable, and the system fails safe when a dependency disappears.

> **Phase 1 (Foundation) is complete.** Identity, portfolios, the demo broker, the
> trading gate, the kill switch and the audit log all work end to end. **No route
> in this API can place an order** — orders may only ever be created behind the
> risk engine (Phase 7) and order manager (Phase 8). See
> [BUILD_STATUS.md](./BUILD_STATUS.md).

---

## Run it locally

You need Node 22+, PostgreSQL 16 and (optionally) Redis.

```bash
git clone <this repo> && cd ZuSu-Trading
npm install

cp .env.example .env
# Generate the three secrets and paste them into .env:
#   openssl rand -base64 48   # JWT_SECRET
#   openssl rand -base64 48   # COOKIE_SECRET
#   openssl rand -base64 32   # CREDENTIAL_ENCRYPTION_KEY
# and point DATABASE_URL at your PostgreSQL.

npm run build -w @zusu/shared   # the API and web client both import it
npm run db:generate             # Prisma client
npm run db:deploy               # apply migrations
npm run seed                    # demo users, portfolio, positions, strategies

npm run dev                     # API on :4000, web client on :5173
```

Open <http://localhost:5173> and sign in with any seeded account:

| Email                | Password           | Role                                           |
| -------------------- | ------------------ | ---------------------------------------------- |
| `admin@zusu.local`   | `DemoTrading2026!` | ADMIN — prompted to enrol MFA on first sign-in |
| `manager@zusu.local` | `DemoTrading2026!` | MANAGER — can trade, cannot change risk limits |
| `client@zusu.local`  | `DemoTrading2026!` | CLIENT — read-only, one portfolio              |
| `viewer@zusu.local`  | `DemoTrading2026!` | VIEWER — limited read-only                     |

The whole application is explorable in DEMO mode with **no API credentials of any
kind**: market data comes from a deterministic simulator and orders would go to a
simulated venue.

API docs are at <http://localhost:4000/docs>.

### With Docker

```bash
cp .env.example .env      # fill in the three secrets
docker compose up --build
docker compose exec api npx --workspace @zusu/api prisma migrate deploy
```

The web client is on <http://localhost:8080> and proxies `/api` to the API
container, so the browser sees a single origin.

## Commands

| Command                | What it does                                              |
| ---------------------- | --------------------------------------------------------- |
| `npm run dev`          | API and web client in watch mode                          |
| `npm test`             | 153 tests across shared, API (unit + integration) and web |
| `npm run typecheck`    | TypeScript across all three packages                      |
| `npm run lint`         | ESLint, zero warnings tolerated                           |
| `npm run build`        | Production build of all three packages                    |
| `npm run db:migrate`   | Create and apply a migration in development               |
| `npm run db:reset`     | Drop, re-migrate and re-seed                              |
| `npm run docs:openapi` | Regenerate `docs/openapi.json` from the route schemas     |

Integration tests need a PostgreSQL database at
`postgresql://zusu:zusu@127.0.0.1:5432/zusu_trading_test` (override with
`TEST_DATABASE_URL`). They run the real migrations, so the database triggers and
constraints are exercised, not mocked.

## What is enforced, not just intended

- **AI never authorises a trade.** It produces a structured, schema-validated
  opinion that becomes one input to a deterministic risk decision.
- **The environment is unmistakable.** 🔵 DEMO / 🟡 PAPER / 🔴 LIVE is a full-width
  banner, and crossing environments is blocked by database triggers, the broker
  registry and the data model independently.
- **Live trading is off by default.** `ALLOW_LIVE_TRADING=false` blocks it even
  with a live portfolio and real credentials.
- **The audit log cannot be edited.** PostgreSQL refuses `UPDATE`, `DELETE` and
  `TRUNCATE` on it, and each row is hash-chained to its predecessor.
- **Clients cannot see each other.** One authorization choke point, and reaching
  another client's portfolio returns 404 (a 403 would confirm it exists) and is
  audited. Covered by isolation tests that drive the HTTP surface.
- **Orders are idempotent.** A crash immediately after submission cannot produce a
  second order.
- **Nothing pretends to work.** Services that are not built report `DISABLED` with
  the phase that delivers them; a value the backend could not compute renders as
  `—`, never as `0`; UI panels with no engine behind them say so.

## Documentation

| Document                                 | Contents                                                          |
| ---------------------------------------- | ----------------------------------------------------------------- |
| [ARCHITECTURE.md](./ARCHITECTURE.md)     | Execution pipeline, services, data model, security, failure modes |
| [BUILD_STATUS.md](./BUILD_STATUS.md)     | What is done, blocked, known-limited, and next                    |
| [ROADMAP.md](./ROADMAP.md)               | The nine phases and their exit criteria                           |
| [API.md](./API.md)                       | Endpoints, conventions and error codes                            |
| [docs/openapi.json](./docs/openapi.json) | Generated OpenAPI specification                                   |

## Security

Broker credentials are encrypted at rest with AES-256-GCM and never leave the API.
Passwords are scrypt-hashed. Administrators must use TOTP. Sessions are `httpOnly`
`SameSite=Lax` cookies with rotating refresh tokens and reuse detection, plus a
double-submit CSRF token. Secrets belong in environment variables locally and a
secrets manager in production — **never in this repository**.

## A note on scope

Trading involves substantial risk of loss. This software is a tool; it is not
investment advice, and labelling an operator "not an investment advisor" does not
by itself make an activity lawful. Anyone operating this system is responsible for
determining which regulatory framework applies to them, with qualified legal and
compliance advice. The platform provides configurable disclosures, consent records
and audit retention to support that; it does not assume any particular answer.
