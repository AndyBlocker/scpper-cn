

# SCPPER-CN

SCPPER-CN is a monorepo-based platform designed for wiki data synchronization, vote ranking, user management, and content analysis. Built with Node.js, TypeScript, and modern web frameworks, it powers a comprehensive suite of microservices for fetching, processing, caching, and displaying wiki-related metrics and user interactions.

## 📦 Architecture & Services

| Package | Description |
|---------|-------------|
| `frontend` | Nuxt 4 web application with Vue 3, TailwindCSS, charts, and interactive graphs. |
| `bff` | Backend-for-Frontend (Express.js) handling API routing, proxying, rate limiting, and Redis caching. |
| `backend` | Core data engine with Prisma ORM. Handles data sync, ranking analysis, legacy migrations, and repair utilities. |
| `user-backend` | Authentication & user profile service (Express + Prisma) with QQ/Wikidot binding support. |
| `avatar-agent` | Avatar & page image processing service. Handles fetching, caching, resizing (Sharp), and variant generation. |
| `syncer` | Vote sentinel and sync-v2 worker for continuous data synchronization and scanning. |
| `forum-crawler` | Headless forum scraping tool using Playwright and Cheerio for Wikidot threads. |
| `mail-agent` | Email notification service powered by Nodemailer. |
| `shared/gacha-types` | Shared TypeScript type definitions. |

## 🛠 Prerequisites

- **Node.js** `>= 20.10` (as specified in `avatar-agent`)
- **PostgreSQL** database instance
- **Redis** instance (for BFF caching & rate limiting)
- **npm** or **pnpm** (monorepo compatible)
- Git & Bash (for workflow scripts)

## 🚀 Installation

```bash
# 1. Clone the repository
git clone https://github.com/AndyBlocker/scpper-cn.git
cd scpper-cn

# 2. Install dependencies across all packages
npm install

# 3. Configure environment variables
cp .env.example .env  # Create your .env file with required DB, Redis, and API credentials
```

> 💡 **Environment Variables:** Required variables include `DATABASE_URL`, `REDIS_URL`, `PORT`, `HOST`, `AVATAR_ROOT`, `PAGE_IMAGE_WORKER_ENABLED`, and upstream Wikidot configuration. Refer to `avatar-agent/src/config.ts` and standard Prisma/Express defaults for the full list.

## 💻 Development & Usage

Services are managed independently from their respective directories. Most packages support hot-reloading in development mode.

```bash
# Frontend (Nuxt)
cd frontend && npm run dev

# BFF API Gateway
cd bff && npm run dev

# User Backend & Auth
cd user-backend && npm run dev

# Avatar & Image Agent
cd avatar-agent && npm run dev

# Syncer (Sentinel & Sync Workers)
cd syncer && npm run dev
# Or run specific workers:
# npm run sentinel  # Vote sentinel
# npm run sync      # Sync-v2 service
# npm run sync:hourly  # Hourly sync interval

# Mail Agent
cd mail-agent && npm run dev

# Forum Crawler
cd forum-crawler && npm run scrape
```

### Production Deployment
The `bff` and `user-backend` services include PM2 ecosystem configurations for process management:
```bash
cd bff && npm run pm2:start
cd user-backend && npm run pm2:start
```

## 🗄 Database & Migrations

The core `backend` and `user-backend` services use Prisma ORM with PostgreSQL.

```bash
# Generate Prisma client
cd backend && npm run db:generate

# Create & apply migrations
cd backend && npm run db:migrate

# Launch Prisma Studio (GUI database viewer)
cd backend && npm run db:studio

# Reset/Seed (use with caution in production)
cd backend && npm run db:reset
```

## 📊 Data Sync & Analysis Tools

The `backend` package exposes a powerful CLI for data pipeline management, ranking analysis, and integrity repairs:

| Command | Description |
|---------|-------------|
| `npm run sync` / `sync:full` | Sync wiki data (full or incremental) |
| `npm run analyze` / `analyze:incremental` | Run ranking & metric analysis pipelines |
| `npm run query:stats` / `query:rankings` | Fetch database statistics & user rankings |
| `npm run repair:user-vote-stats` | Recalculate user vote metrics |
| `npm run tags:sync -- --force` | Refresh tag cache & synchronization |
| `npm run forum-sync` | Sync forum thread metadata |
| `npm run check:vote-integrity` | Audit voting data consistency |

## 🤝 Contributing

1. Fork the repository and create a feature branch.
2. Run linting, typechecking, and tests before committing:
   ```bash
   cd <service-directory>
   npm run lint
   npm run typecheck
   npm run test  # If available
   ```
3. Submit a Pull Request following the provided `.github/pull_request_template.md`, including validation steps, config/migration notes, and PM2 deployment targets if applicable.

## 📜 License

This project is maintained by AndyBlocker. For licensing details, refer to the repository license file.
