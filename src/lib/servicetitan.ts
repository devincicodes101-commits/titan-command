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

// Runs a ServiceTitan pre-built report (Reporting API), paginating until exhausted.
// Reports return rows as positional arrays matching the `fields` order from the
// report's metadata — not objects — so callers must index by position.
async function runReport(
  creds: STCredentials,
  category: string,
  reportId: number,
  parameters: { name: string; value: unknown }[]
): Promise<unknown[][]> {
  const token = await getAccessToken(creds);
  const rows: unknown[][] = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const res = await fetch(
      `${API_BASE}/reporting/v2/tenant/${creds.stTenantId}/report-category/${category}/reports/${reportId}/data?page=${page}&pageSize=500`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "ST-App-Key": creds.appKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ parameters }),
      }
    );
    if (!res.ok) {
      throw new Error(`ServiceTitan report ${reportId} error (${res.status}): ${await res.text()}`);
    }
    const json = await res.json();
    rows.push(...(json.data ?? []));
    hasMore = json.hasMore;
    page += 1;
  }
  return rows;
}

export interface STRevenueSummary {
  total: number;
  byBusinessUnit: Record<string, number>;
}

// "Invoice Summary by Business Unit" (report 3201, accounting category) — ServiceTitan's
// own accounting report, same numbers Reed would see if he ran it himself. DateType=0
// filters by Invoice Date. Row shape: [BusinessUnit, Number, Subtotal, DiscountTotal,
// FeeTotal, Tax, Total, Status, IsPrevailingWageJob].
export async function getRevenueSummary(
  creds: STCredentials,
  from: string,
  to: string
): Promise<STRevenueSummary> {
  const rows = await runReport(creds, "accounting", 3201, [
    { name: "DateType", value: 0 },
    { name: "From", value: from },
    { name: "To", value: to },
  ]);
  let total = 0;
  const byBusinessUnit: Record<string, number> = {};
  for (const row of rows) {
    const bu = row[0] as string | null;
    const invoiceTotal = Number(row[6]) || 0;
    total += invoiceTotal;
    if (bu) byBusinessUnit[bu] = (byBusinessUnit[bu] ?? 0) + invoiceTotal;
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  for (const bu in byBusinessUnit) byBusinessUnit[bu] = round2(byBusinessUnit[bu]);
  return { total: round2(total), byBusinessUnit };
}

// Counts completed jobs for one business unit using the API's own totalCount,
// rather than paginating every job just to count them.
export async function getCompletedJobsCount(
  creds: STCredentials,
  businessUnitId: number,
  completedOnOrAfter: string
): Promise<number> {
  const data = await stFetch(
    creds,
    `/jpm/v2/tenant/${creds.stTenantId}/jobs?businessUnitId=${businessUnitId}&jobStatus=Completed&completedOnOrAfter=${completedOnOrAfter}T00:00:00Z&pageSize=1&includeTotal=true`
  );
  return data.totalCount ?? 0;
}

export interface STDepartmentPerformance {
  revenue: number;
  jobsCompleted: number;
}

// Combines revenue-by-business-unit with a completed-jobs count per unit, for the
// 4-category HVAC dashboard (Maintenance/Service/Installation cards).
export async function getDepartmentPerformance(
  creds: STCredentials,
  businessUnits: { id: number; name: string }[],
  from: string,
  to: string
): Promise<Record<string, STDepartmentPerformance>> {
  const revenue = await getRevenueSummary(creds, from, to);
  const result: Record<string, STDepartmentPerformance> = {};
  await Promise.all(
    businessUnits.map(async (bu) => {
      const jobsCompleted = await getCompletedJobsCount(creds, bu.id, from);
      result[bu.name] = {
        revenue: revenue.byBusinessUnit[bu.name] ?? 0,
        jobsCompleted,
      };
    })
  );
  return result;
}
