# API

Base URL: `/api`. The machine-readable specification is
[`docs/openapi.json`](./docs/openapi.json), generated from the same zod schemas the
routes validate against — it cannot drift from the implementation. Regenerate with
`npm run docs:openapi`; browse it at `/docs` when the API is running outside
production.

## Conventions

**Authentication** is by cookie. `POST /api/auth/login` sets three cookies:

| Cookie      | Contents                                 | Flags                                |
| ----------- | ---------------------------------------- | ------------------------------------ |
| `zusu_at`   | access token, 15 minutes                 | `httpOnly`, `SameSite=Lax`, `Secure` |
| `zusu_rt`   | refresh token, 14 days, path `/api/auth` | `httpOnly`, `SameSite=Lax`, `Secure` |
| `zusu_csrf` | CSRF token                               | readable by script, by design        |

Every non-`GET` request must echo the CSRF cookie in an `x-csrf-token` header. The
pre-session endpoints (`/auth/login`, `/auth/mfa/*`, `/auth/refresh`) are exempt;
they are protected by `SameSite=Lax` and a stricter rate limit.

**Money and quantities are decimal strings**, never JSON numbers — `"1234.56"`, not
`1234.56`. Sending a float where a decimal string is expected is a validation
error. A value the server could not compute is `null`, never `0`.

**Errors** all share one shape:

```json
{
  "error": {
    "code": "TRADING_HALTED",
    "message": "Trading is halted: quote feed looks wrong",
    "details": [],
    "correlationId": "0f0a…"
  }
}
```

`code` is stable and machine-readable; `message` is written to be shown to the
person who was refused. `correlationId` matches the request id in the logs.

| Code                    | HTTP | Meaning                                                                  |
| ----------------------- | ---- | ------------------------------------------------------------------------ |
| `VALIDATION_FAILED`     | 422  | Request body/query did not match the schema                              |
| `UNAUTHENTICATED`       | 401  | No session, or it expired                                                |
| `MFA_REQUIRED`          | 401  | Session predates a required second factor                                |
| `FORBIDDEN`             | 403  | Authenticated, but the role lacks the permission                         |
| `NOT_FOUND`             | 404  | Missing — or not yours (deliberately indistinguishable)                  |
| `CONFLICT`              | 409  | State conflict, e.g. resuming a portfolio with a reconciliation mismatch |
| `ENVIRONMENT_MISMATCH`  | 409  | Something tried to cross DEMO/PAPER/LIVE                                 |
| `LIVE_TRADING_DISABLED` | 403  | `ALLOW_LIVE_TRADING` is false on this deployment                         |
| `TRADING_HALTED`        | 409  | Kill switch or automatic halt is engaged                                 |
| `RISK_REJECTED`         | 422  | The risk engine refused; `details` lists the reasons                     |
| `BROKER_UNAVAILABLE`    | 503  | Broker call failed — **no order state has been assumed**                 |
| `RATE_LIMITED`          | 429  | Too many requests                                                        |
| `NOT_IMPLEMENTED`       | 501  | The capability arrives in a later phase                                  |

**Rate limits**: 300 requests/minute per principal (per IP when unauthenticated);
10/minute on credential endpoints.

---

## Authentication — `/api/auth`

| Method | Path            | Permission          | Description                                                              |
| ------ | --------------- | ------------------- | ------------------------------------------------------------------------ |
| POST   | `/login`        | —                   | Email + password. Returns a session, or an MFA challenge                 |
| POST   | `/mfa/enrol`    | MFA challenge token | Starts enrolment; returns the secret, `otpauth://` URI and a QR data URL |
| POST   | `/mfa/verify`   | MFA challenge token | Completes the challenge (and enrolment) and issues a session             |
| POST   | `/mfa/setup`    | session             | Starts enrolment for the signed-in user                                  |
| POST   | `/mfa/activate` | session             | Confirms a code and switches MFA on                                      |
| POST   | `/refresh`      | refresh cookie      | Rotates the refresh token, issues a new access token                     |
| POST   | `/logout`       | —                   | Revokes the session family                                               |
| GET    | `/me`           | session             | The current user, their permissions and reachable portfolios             |

`POST /login` returns one of three shapes:

```jsonc
{ "status": "AUTHENTICATED", "user": { … }, "csrfToken": "…", "accessTokenExpiresAt": "…" }
{ "status": "MFA_REQUIRED",           "mfaToken": "…" }  // enrolled; needs a code
{ "status": "MFA_ENROLMENT_REQUIRED", "mfaToken": "…" }  // administrator, not yet enrolled
```

A refresh token that has already been rotated is treated as stolen: the whole
session family is revoked and `TOKEN_REUSE_DETECTED` is written to the audit log.

## Clients — `/api/clients`

| Method | Path | Permission     |
| ------ | ---- | -------------- |
| GET    | `/`  | `client:read`  |
| POST   | `/`  | `client:write` |

## Portfolios — `/api/portfolios`

| Method | Path              | Permission        | Description                                                  |
| ------ | ----------------- | ----------------- | ------------------------------------------------------------ |
| GET    | `/`               | `portfolio:read`  | Portfolios the caller may see — scoped, never the full list  |
| POST   | `/`               | `portfolio:write` | Creates a portfolio with conservative default risk limits    |
| GET    | `/{id}`           | `portfolio:read`  | Summary: cash, positions value, equity, daily P&L, risk used |
| PATCH  | `/{id}`           | `portfolio:write` | Rename, change execution mode, deactivate                    |
| GET    | `/{id}/positions` | `position:read`   | Open positions                                               |

Creating a `LIVE` portfolio fails with `LIVE_TRADING_DISABLED` unless
`ALLOW_LIVE_TRADING=true`. A portfolio's environment can never be changed
afterwards — the database refuses.

`markPrice`, `marketValue`, `unrealizedPnl`, `positionsValue` and `equity` are
`null` when the environment has no market-data source. `dailyPnl` is `null` until a
prior snapshot exists to measure against, and it excludes deposits and withdrawals.

## Broker (read-only) — `/api/broker`

| Method | Path                   | Permission            | Description                                             |
| ------ | ---------------------- | --------------------- | ------------------------------------------------------- |
| GET    | `/{id}/account`        | `broker_account:read` | The broker's own view of the account                    |
| GET    | `/{id}/positions`      | `broker_account:read` | The broker's positions — the reconciliation counterpart |
| GET    | `/{id}/quote/{symbol}` | `portfolio:read`      | A quote from the environment's market-data source       |

> **There is no order-placement endpoint, deliberately.** Orders may only be
> created behind the risk engine (Phase 7) and order manager (Phase 8). A route
> that placed orders today would be a path that bypasses risk checks.

Broker credentials are never returned by any endpoint, at any role.

## Risk — `/api/risk`

| Method | Path                      | Permission             | Description                                                 |
| ------ | ------------------------- | ---------------------- | ----------------------------------------------------------- |
| GET    | `/portfolios/{id}/gate`   | `risk:read`            | May this portfolio trade right now, and what is blocking it |
| GET    | `/portfolios/{id}/limits` | `risk:read`            | Active risk limits                                          |
| POST   | `/kill-switch`            | `kill_switch:activate` | Stop trading — one portfolio, or all reachable ones         |
| POST   | `/portfolios/{id}/resume` | `kill_switch:release`  | Release a halt (administrators only)                        |

The gate returns every blocker with a severity, so the UI can explain a refusal:

```json
{
  "portfolioId": "…",
  "allowed": false,
  "blockers": [
    {
      "code": "TRADING_HALTED",
      "message": "Trading is halted: quote feed looks wrong",
      "severity": "BLOCKING"
    }
  ],
  "checkedAt": "2026-09-10T12:00:00.000Z"
}
```

The kill switch cancels resting entry orders and **leaves open positions alone** —
halting trading must never itself liquidate an account. Closing positions is a
separate, explicitly confirmed action.

## Audit — `/api/audit`

| Method | Path      | Permission   | Description                                                 |
| ------ | --------- | ------------ | ----------------------------------------------------------- |
| GET    | `/`       | `audit:read` | Paginated entries; filter by portfolio, action, actor, date |
| GET    | `/verify` | `audit:read` | Recomputes the hash chain and reports the first broken link |

The log is append-only at the database level and each row's hash covers its
predecessor's, so an edit or deletion breaks every subsequent link.

## System — `/api/system`

| Method | Path           | Permission    | Description                                     |
| ------ | -------------- | ------------- | ----------------------------------------------- |
| GET    | `/live`        | —             | Liveness probe                                  |
| GET    | `/ready`       | —             | Readiness; 503 when the database is unreachable |
| GET    | `/health`      | `system:read` | Per-service status for the health panel         |
| GET    | `/environment` | session       | Which environment this deployment runs in       |

Services that are not built yet report `DISABLED` with the phase that delivers
them, rather than a green light for something that is not running.

## WebSocket — `/ws`

Authenticates with the same access-token cookie; an unauthenticated socket is
closed with code 4401. Messages are filtered by the same portfolio scope as the
REST API.

```jsonc
{
  "event": "risk.halted",
  "correlationId": "…", // threads market event → signal → order → fill → P&L
  "portfolioId": "…", // null for system-wide events
  "emittedAt": "2026-09-10T12:00:00.000Z",
  "payload": {},
}
```

Events: `quote.updated`, `signal.created`, `signal.expired`, `order.updated`,
`position.updated`, `portfolio.updated`, `risk.warning`, `risk.halted`,
`system.health`. Phase 1 emits `risk.halted`; the rest arrive with the engines
that produce them.
