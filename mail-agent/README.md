# mail-agent

Standalone HTTP microservice responsible for issuing outbound emails (verification codes now, other notifications later). It wraps Nodemailer with project defaults and exposes a minimal JSON API so other services can trigger messages without handling SMTP details directly.

## Features
- Verification template with localized subject/body and shared SMTP headers
- Extensible template registry (`verification`, `generic`, add more in `src/lib/templates.mjs`)
- Sliding window rate limiting by message type + recipient email
- Structured JSON logging for delivery successes/failures and lifecycle events
- PM2 ecosystem file for production deployment and `.env`-driven configuration

## Endpoints
- `GET /health` — simple status/clock check for uptime monitoring.
- `POST /send` — accepts a JSON payload containing:
  ```jsonc
  {
    "type": "verification",      // or "generic"; customize in templates.mjs
    "recipient": {                // required
      "email": "user@example.com",
      "name": "User"            // optional
    },
    "payload": {                  // schema depends on type
      "code": "123456",
      "ttlMinutes": 15,
      "reason": "SCP-CN 登录验证"
    },
    "metadata": {                 // optional
      "headers": { "X-Request-ID": "abc" }
    }
  }
  ```
  Responses follow HTTP status codes (`200`, `400`, `413`, `429`, `500`, `502`), always with JSON bodies.

## Configuration
All runtime settings come from environment variables loaded via `dotenv` (`mail-agent/.env` or process env). See `.env.example` for defaults. Key options:
- **SMTP**: `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_SECURE`, `MAIL_SMTP_USER`, `MAIL_SMTP_PASS`, `MAIL_FROM_NAME`, `MAIL_FROM_ADDRESS`, `MAIL_REPLY_TO`
- **HTTP**: `MAIL_AGENT_PORT` (default `3110`), `MAIL_AGENT_MAX_BODY_BYTES`
- **Rate limiting**: `MAIL_AGENT_RATE_WINDOW_MS`, `MAIL_AGENT_RATE_MAX`, optional per-type overrides via `MAIL_AGENT_RATE_LIMIT_OVERRIDES` JSON (e.g. `{"generic":{"windowMs":3600000,"max":20}}`)

Missing SMTP credentials cause the service to exit on startup to prevent silent misconfiguration.

## Development & Local Runs
```bash
npm install                # once at repo root
npm run mail:dev           # starts with node --watch (defaults to localhost:3110)
```
The watcher uses the same env loading as production. Override settings by exporting env vars inline or creating `mail-agent/.env`.

## Production via PM2
```bash
pm2 start mail-agent/ecosystem.config.cjs
pm2 logs mail-agent         # tail structured logs
pm2 restart mail-agent      # graceful reload
```
The ecosystem file runs a single instance, autorestarts on failure, and caps memory at 256 MB. Adjust as needed before scaling.

## Testing Utility
`npm run mail:test` executes `scripts/test-send.mjs`, posting a sample message to the running agent. Configure target email and optional overrides with env vars (`MAIL_AGENT_TEST_TO`, `MAIL_AGENT_URL`, etc.) to validate deliveries and rate limiting behaviour.

## Code Structure
- `src/config.mjs` — env parsing/validation and shared defaults
- `src/server.mjs` — HTTP server, routing, validation, logging, shutdown
- `src/lib/` — helper modules (`mailer`, `rateLimiter`, `templates`)
- `scripts/test-send.mjs` — manual testing CLI
- `ecosystem.config.cjs` — PM2 process definition

When adding new notification types, extend `src/lib/templates.mjs` with the rendering logic and update client payload schemas accordingly. Consider adding targeted rate-limit overrides if new classes of traffic have different expectations.
