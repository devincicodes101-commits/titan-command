import { decrypt } from "./crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

export interface STCredentials {
  stTenantId: string;
  appKey: string;
  clientId: string;
  clientSecretEncrypted: string;
}

export interface STBusinessUnit {
  id: number;
  name: string;
  active: boolean;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Keyed by clientId — short-lived (15 min) tokens, refreshed automatically once stale.
const tokenCache = new Map<string, CachedToken>();

async function getAccessToken(creds: STCredentials): Promise<string> {
  const cached = tokenCache.get(creds.clientId);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const clientSecret = decrypt(creds.clientSecretEncrypted);
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: creds.clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    throw new Error(`ServiceTitan auth failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  tokenCache.set(creds.clientId, {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  });
  return json.access_token;
}

async function stFetch(creds: STCredentials, path: string): Promise<any> {
  const token = await getAccessToken(creds);
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "ST-App-Key": creds.appKey,
    },
  });
  if (!res.ok) {
    throw new Error(`ServiceTitan API error (${res.status}) for ${path}: ${await res.text()}`);
  }
  return res.json();
}

export async function testConnection(
  creds: STCredentials
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await getAccessToken(creds);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getBusinessUnits(creds: STCredentials): Promise<STBusinessUnit[]> {
  const data = await stFetch(
    creds,
    `/settings/v2/tenant/${creds.stTenantId}/business-units?active=true&pageSize=200`
  );
  return (data.data ?? []).map((bu: { id: number; name: string; active: boolean }) => ({
    id: bu.id,
    name: bu.name.trim(),
    active: bu.active,
  }));
}
