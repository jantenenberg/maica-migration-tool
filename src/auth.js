const crypto = require('crypto');
const express = require('express');
const jsforce = require('jsforce');
const router = express.Router();

/** Token endpoint must be login.salesforce.com or test.salesforce.com, never instance URLs. */
function getTokenEndpointLoginUrl(loginUrl) {
  if (!loginUrl) return 'https://login.salesforce.com';
  const u = loginUrl.toLowerCase();
  if (u.includes('test.salesforce.com')) return 'https://test.salesforce.com';
  return 'https://login.salesforce.com';
}

const VALID_ORG_TYPES = ['source', 'target'];

function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generatePKCE() {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(64));
  const codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function getOAuth2Config(orgType, loginUrlOverride) {
  const prefix = orgType === 'source' ? 'SF_SOURCE' : 'SF_TARGET';
  const loginUrl = loginUrlOverride || process.env[`${prefix}_LOGIN_URL`] || 'https://login.salesforce.com';
  return new jsforce.OAuth2({
    clientId: process.env[`${prefix}_CLIENT_ID`],
    clientSecret: process.env[`${prefix}_CLIENT_SECRET`],
    redirectUri: process.env[`${prefix}_CALLBACK_URL`],
    loginUrl,
  });
}

/**
 * Create a jsforce.Connection from stored session data.
 * Attaches a 'refresh' event handler to update the session when the token auto-refreshes.
 * @returns {jsforce.Connection|null} The connection, or null if not authenticated
 */
function getConnection(req, orgType) {
  const data = req.session?.[orgType];
  if (!data?.accessToken || !data?.instanceUrl) return null;

  const oauth2 = getOAuth2Config(orgType);
  const conn = new jsforce.Connection({
    oauth2,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    instanceUrl: data.instanceUrl,
  });

  conn.on('refresh', (accessToken, tokenResponse) => {
    if (req.session?.[orgType]) {
      req.session[orgType].accessToken = accessToken;
      if (tokenResponse?.instance_url) req.session[orgType].instanceUrl = tokenResponse.instance_url;
      if (tokenResponse?.refresh_token) req.session[orgType].refreshToken = tokenResponse.refresh_token;
    }
  });

  return conn;
}

/**
 * Middleware factory: returns 401 if the session doesn't have that org type connected.
 */
function requireAuth(orgType) {
  return (req, res, next) => {
    if (!req.session?.[orgType]?.accessToken) {
      return res.status(401).json({ error: `Not connected to ${orgType} org` });
    }
    next();
  };
}

// Validate orgType param
function validateOrgType(req, res, next) {
  const orgType = req.params.orgType;
  if (!VALID_ORG_TYPES.includes(orgType)) {
    return res.status(400).json({ error: 'orgType must be "source" or "target"' });
  }
  req.orgType = orgType;
  next();
}

// GET /oauth/:orgType/login
router.get('/:orgType/login', validateOrgType, (req, res) => {
  const { orgType } = req;
  const loginUrlOverride = req.query.loginUrl;

  const oauth2 = getOAuth2Config(orgType, loginUrlOverride);
  req.session.pendingOrgType = orgType;
  req.session.oauthLoginUrl = oauth2.loginUrl;

  const { codeVerifier, codeChallenge } = generatePKCE();
  req.session.codeVerifier = codeVerifier;

  let authUrl = oauth2.getAuthorizationUrl({ scope: 'api refresh_token full' });
  authUrl += (authUrl.includes('?') ? '&' : '?') + `code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256`;
  res.redirect(authUrl);
});

// GET /oauth/:orgType/callback
router.get('/:orgType/callback', validateOrgType, async (req, res) => {
  const { orgType } = req;

  if (req.query.error) {
    const error = encodeURIComponent(req.query.error);
    return res.redirect(`/?error=${error}&orgType=${orgType}`);
  }

  const code = req.query.code;
  if (!code) {
    return res.redirect(`/?error=${encodeURIComponent('No authorization code received')}&orgType=${orgType}`);
  }

  const codeVerifier = req.session?.codeVerifier;
  if (!codeVerifier) {
    return res.redirect(`/?error=${encodeURIComponent('Session expired — please try connecting again')}&orgType=${orgType}`);
  }

  try {
    const oauth2 = getOAuth2Config(orgType);
    const storedLoginUrl = req.session?.oauthLoginUrl || oauth2.loginUrl;
    delete req.session.oauthLoginUrl;
    delete req.session.codeVerifier;

    const tokenLoginUrl = getTokenEndpointLoginUrl(storedLoginUrl);
    oauth2.loginUrl = tokenLoginUrl;
    oauth2.authzServiceUrl = `${tokenLoginUrl}/services/oauth2/authorize`;
    oauth2.tokenServiceUrl = `${tokenLoginUrl}/services/oauth2/token`;
    oauth2.codeVerifier = codeVerifier;

    console.log('[OAuth] Token exchange:', {
      tokenUrl: oauth2.tokenServiceUrl,
      grant_type: 'authorization_code',
      client_id: oauth2.clientId,
      redirect_uri: oauth2.redirectUri,
    });

    let tokenData;
    try {
      tokenData = await oauth2.requestToken(code);
    } catch (err) {
      console.log('[OAuth] Token error:', err.message, err.name);
      throw err;
    }

    console.log('[OAuth] Token success:', {
      has_access_token: !!tokenData.access_token,
      has_instance_url: !!tokenData.instance_url,
    });

    const conn = new jsforce.Connection({
      instanceUrl: tokenData.instance_url,
      accessToken: tokenData.access_token,
    });

    const [identity, orgResult, packagesResult] = await Promise.all([
      conn.identity(),
      conn.query(
        'SELECT Id, Name, OrganizationType, IsSandbox, NamespacePrefix FROM Organization LIMIT 1'
      ),
      (async () => {
        try {
          return await conn.tooling.query(
            'SELECT Id, SubscriberPackage.Name, SubscriberPackage.NamespacePrefix, SubscriberPackageVersion.MajorVersion, SubscriberPackageVersion.MinorVersion, SubscriberPackageVersion.PatchVersion FROM InstalledSubscriberPackage ORDER BY SubscriberPackage.Name'
          );
        } catch {
          return { records: [] };
        }
      })(),
    ]);

    const org = orgResult.records[0] || {};
    const installedPackages = (packagesResult.records || []).map((r) => ({
      name: r.SubscriberPackage?.Name,
      namespacePrefix: r.SubscriberPackage?.NamespacePrefix,
      version: r.SubscriberPackageVersion
        ? `${r.SubscriberPackageVersion.MajorVersion}.${r.SubscriberPackageVersion.MinorVersion}.${r.SubscriberPackageVersion.PatchVersion}`
        : null,
    }));

    req.session[orgType] = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      instanceUrl: tokenData.instance_url,
      userId: identity.user_id,
      orgId: identity.organization_id,
      username: identity.username,
      displayName: identity.display_name,
      orgName: org.Name,
      orgType,
      isSandbox: org.IsSandbox === true,
      namespace: org.NamespacePrefix,
      installedPackages,
    };

    res.redirect(`/?connected=${orgType}`);
  } catch (err) {
    const error = encodeURIComponent(err.message || 'OAuth failed');
    res.redirect(`/?error=${error}&orgType=${orgType}`);
  }
});

// POST /oauth/:orgType/disconnect
router.post('/:orgType/disconnect', validateOrgType, (req, res) => {
  delete req.session[req.orgType];
  res.json({ success: true });
});

/**
 * GET /api/status handler — connection status for both orgs
 */
function getStatusHandler(req, res) {
  const source = req.session?.source;
  const target = req.session?.target;

  res.json({
    source: source?.accessToken
      ? {
          connected: true,
          username: source.username,
          displayName: source.displayName,
          orgId: source.orgId,
          orgName: source.orgName,
          orgType: 'source',
          isSandbox: source.isSandbox,
          instanceUrl: source.instanceUrl,
          installedPackages: source.installedPackages,
        }
      : { connected: false },
    target: target?.accessToken
      ? {
          connected: true,
          username: target.username,
          displayName: target.displayName,
          orgId: target.orgId,
          orgName: target.orgName,
          orgType: 'target',
          isSandbox: target.isSandbox,
          instanceUrl: target.instanceUrl,
          installedPackages: target.installedPackages,
        }
      : { connected: false },
  });
}

module.exports = router;
module.exports.getConnection = getConnection;
module.exports.requireAuth = requireAuth;
module.exports.getStatusHandler = getStatusHandler;
