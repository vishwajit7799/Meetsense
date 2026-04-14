import { ConfidentialClientApplication } from '@azure/msal-node';

const msalConfig = {
  auth: {
    clientId:     process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    authority:    `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}`,
  },
};

const msalClient = new ConfidentialClientApplication(msalConfig);

// Scopes needed: only read calendar events — no admin consent required
export const SCOPES = [
  'User.Read',
  'Calendars.Read',
  'offline_access',
];

export function getAuthUrl(state) {
  return msalClient.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: process.env.MICROSOFT_REDIRECT_URI,
    state,
  });
}

export async function exchangeCode(code) {
  return msalClient.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: process.env.MICROSOFT_REDIRECT_URI,
  });
}

export async function refreshAccessToken(refreshToken) {
  return msalClient.acquireTokenByRefreshToken({
    refreshToken,
    scopes: SCOPES,
  });
}

// Fetch with auto token refresh
export async function graphFetch(accessToken, path) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph API ${res.status}: ${err}`);
  }
  return res.json();
}
