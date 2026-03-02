require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const cors = require('cors');

const auth = require('./src/auth');
const schemaRouter = require('./src/schema');
const customizationsRouter = require('./src/customizations');
const referencesRouter = require('./src/references');

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// Railway runs behind a reverse proxy — trust X-Forwarded-* headers
app.set('trust proxy', 1);

// Session store: Postgres on Railway, MemoryStore for local dev
let sessionStore;
if (process.env.DATABASE_URL) {
  const pgSession = require('connect-pg-simple')(session);
  sessionStore = new pgSession({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: true,
  });
} else {
  sessionStore = new session.MemoryStore();
  console.warn('⚠️  No DATABASE_URL — using in-memory session store (sessions will not persist across restarts)');
}

// CORS: permissive in dev, restrictive in production
const allowedOrigin = isProduction && (process.env.APP_URL || process.env.RAILWAY_PUBLIC_DOMAIN)
  ? (process.env.APP_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`)
  : null;
app.use(cors({
  origin: (origin, cb) => {
    if (!allowedOrigin) return cb(null, true); // dev: allow all
    if (!origin) return cb(null, true); // same-origin requests have no Origin header
    cb(null, origin === allowedOrigin);
  },
  credentials: true,
}));

app.use(express.json());
app.use(
  session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

// API routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.get('/api/status', auth.getStatusHandler);

app.use('/oauth', auth);
app.use('/api', schemaRouter);
app.use('/api', customizationsRouter);
app.use('/api', referencesRouter);

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback — serve index.html for any non-API, non-static route
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Startup validation — log what is configured vs missing (do not crash so Railway health check passes)
const envVars = [
  'PORT',
  'SESSION_SECRET',
  'DATABASE_URL',
  'SF_SOURCE_CLIENT_ID',
  'SF_SOURCE_CLIENT_SECRET',
  'SF_SOURCE_CALLBACK_URL',
  'SF_SOURCE_LOGIN_URL',
  'SF_TARGET_CLIENT_ID',
  'SF_TARGET_CLIENT_SECRET',
  'SF_TARGET_CALLBACK_URL',
  'SF_TARGET_LOGIN_URL',
];
const configured = envVars.filter((v) => process.env[v]);
const missing = envVars.filter((v) => !process.env[v]);

const baseUrl = isProduction && process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${PORT}`;

if (missing.length > 0) {
  console.warn('⚠️  Missing env vars:', missing.join(', '));
  if (missing.includes('SESSION_SECRET') && isProduction) {
    console.warn('   SESSION_SECRET is required in production for secure sessions.');
  }
  if (missing.some((v) => v.startsWith('SF_'))) {
    console.warn('   SF_* vars are required for Salesforce OAuth. Configure in Railway dashboard.');
  }
}

console.log(`
╔══════════════════════════════════════════════════════════════╗
║              Maica Migration Utility                         ║
╠══════════════════════════════════════════════════════════════╣
║  Server:   ${baseUrl.padEnd(47)}║
║  Health:   ${`${baseUrl}/api/health`.padEnd(47)}║
╠══════════════════════════════════════════════════════════════╣
║  Configured: ${configured.length}/${envVars.length} env vars${' '.repeat(35)}║
║  Missing:    ${(missing.length > 0 ? missing.join(', ') : 'none').substring(0, 46).padEnd(47)}║
╚══════════════════════════════════════════════════════════════╝
`);

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
