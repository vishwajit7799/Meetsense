import { ConfidentialClientApplication } from '@azure/msal-node';
import { pool } from '../db/index.js';

const msalConfig = {
  auth: {
    clientId:     process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    authority:    `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID || 'common'}`,
  },
};

const msalClient = new ConfidentialClientApplication(msalConfig);

export const MS_SCOPES = ['User.Read', 'Calendars.Read', 'offline_access'];

export function getMsAuthUrl(state) {
  return msalClient.getAuthCodeUrl({
    scopes:      MS_SCOPES,
    redirectUri: process.env.MICROSOFT_REDIRECT_URI,
    state,
  });
}

export async function exchangeMsCode(code) {
  return msalClient.acquireTokenByCode({
    code,
    scopes:      MS_SCOPES,
    redirectUri: process.env.MICROSOFT_REDIRECT_URI,
  });
}

export async function getValidMsToken(user) {
  if (user.ms_token_expiry && new Date(user.ms_token_expiry) > new Date(Date.now() + 60000)) {
    return user.ms_access_token;
  }
  const result = await msalClient.acquireTokenByRefreshToken({
    refreshToken: user.ms_refresh_token,
    scopes:       MS_SCOPES,
  });
  await pool.query(
    'UPDATE users SET ms_access_token=$1, ms_token_expiry=$2 WHERE id=$3',
    [result.accessToken, result.expiresOn, user.id]
  );
  return result.accessToken;
}

export async function graphFetch(token, path) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Graph API ${res.status}: ${await res.text()}`);
  return res.json();
}
