# Maica Migration Utility

Salesforce org-to-org migration utility for migrating from MaicaCare + MaicaBilling packages to the new merged Maica package. Connects to source and target orgs via OAuth, discovers schema and customizations, maps fields, and deploys updates.

## Architecture

```
┌─────────┐         ┌──────────────────┐         ┌─────────────────┐
│ Browser │ ◄─────► │  Express Server   │ ◄─────► │  Salesforce APIs │
│  (SPA)  │   HTTP  │  (Node.js)       │  OAuth  │  (Source + Target│
└─────────┘         │  - OAuth routes   │   REST  │   orgs)          │
                    │  - Schema API    │         └─────────────────┘
                    │  - Customizations│
                    │  - Session (PG)   │
                    └──────────────────┘
```

## Tech Stack

- **Backend:** Express.js
- **Frontend:** Vanilla HTML/CSS/JS (SPA, no build step)
- **Salesforce API:** jsforce
- **Session:** express-session with connect-pg-simple (Postgres) or MemoryStore (local)
- **Config:** dotenv

## Local Development

1. Copy `.env.example` to `.env` and fill in your values.
2. Install dependencies: `npm install`
3. Run: `npm run dev` (or `npm start`)

```bash
cp .env.example .env
npm install
npm run dev
```

Server runs at `http://localhost:3001`. Use `http://localhost:3001` for callback URLs in your Connected Apps.

### Scripts

- `npm start` — Run production server
- `npm run dev` — Run with `--watch` for hot reload

## Railway Deployment

### 1. Push code to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/your-username/maica-migration-tool.git
git push -u origin main
```

### 2. Create Railway project

1. Go to [railway.app](https://railway.app) and sign in
2. Click **New Project** → **Deploy from GitHub repo**
3. Connect your GitHub account and select the repository

### 3. Add Postgres

1. In your Railway project, click **+ New** → **Database** → **PostgreSQL**
2. Railway automatically sets `DATABASE_URL` for your service
3. Link the Postgres database to your app service (Variables tab → Add Reference)

### 4. Set environment variables

In the Railway dashboard, open your service → **Variables** and add:

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | Yes | Set to `production` |
| `SESSION_SECRET` | Yes | Random string for session encryption |
| `SF_SOURCE_CLIENT_ID` | Yes | Consumer Key from Source Connected App |
| `SF_SOURCE_CLIENT_SECRET` | Yes | Consumer Secret from Source Connected App |
| `SF_SOURCE_CALLBACK_URL` | Yes | **Must use Railway domain** (see below) |
| `SF_SOURCE_LOGIN_URL` | Yes | `https://login.salesforce.com` or `https://test.salesforce.com` |
| `SF_TARGET_CLIENT_ID` | Yes | Consumer Key from Target Connected App |
| `SF_TARGET_CLIENT_SECRET` | Yes | Consumer Secret from Target Connected App |
| `SF_TARGET_CALLBACK_URL` | Yes | **Must use Railway domain** (see below) |
| `SF_TARGET_LOGIN_URL` | Yes | `https://login.salesforce.com` or `https://test.salesforce.com` |

### 5. Callback URLs (critical)

**SF_SOURCE_CALLBACK_URL** and **SF_TARGET_CALLBACK_URL** must use your Railway app domain:

```
https://your-app-name.up.railway.app/oauth/source/callback
https://your-app-name.up.railway.app/oauth/target/callback
```

Find your domain in Railway: **Settings** → **Networking** → **Generate Domain**.

### 6. Update Salesforce Connected Apps

In each Salesforce org (Setup → App Manager → your Connected App):

1. Add the Railway callback URLs to **Callback URL** (comma-separated if you keep localhost for dev)
2. Ensure OAuth scopes include: `api`, `refresh_token`, `full`

## Salesforce Connected App Setup

1. **Setup** → **App Manager** → **New Connected App**
2. Enable **OAuth Settings**
3. Set **Callback URL** to your app URL + `/oauth/source/callback` (or `/oauth/target/callback` for the target org)
4. Select scopes: `Access and manage your data (api)`, `Perform requests at any time (refresh_token)`, `Full access (full)`
5. Save and copy **Consumer Key** and **Consumer Secret** to your env vars

## Project Structure

```
├── server.js              # Express server (entry point)
├── src/
│   ├── auth.js            # Salesforce OAuth routes
│   ├── schema.js          # Schema discovery API routes
│   ├── customizations.js  # Customization discovery API routes
│   └── references.js      # Reference analysis utility
├── public/
│   └── index.html         # Frontend SPA
├── .env.example           # Environment template
├── Procfile               # Railway: web: node server.js
└── railway.toml           # Railway config
```
