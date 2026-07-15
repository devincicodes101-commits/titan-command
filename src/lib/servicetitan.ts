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

function parseRetryAfter(body: string): number {
  const match = body.match(/try again in (\d+) second/i);
  return match ? (parseInt(match[1]) + 2) * 1000 : 15000;
}

async function stFetch(creds: STCredentials, path: string, retries = 2): Promise<any> {
  const token = await getAccessToken(creds);
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "ST-App-Key": creds.appKey,
    },
  });
  if (res.status === 429 && retries > 0) {
    const body = await res.text();
    await new Promise((r) => setTimeout(r, parseRetryAfter(body)));
    return stFetch(creds, path, retries - 1);
  }
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
    let res = await fetch(
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
    if (res.status === 429) {
      const body = await res.text();
      await new Promise((r) => setTimeout(r, parseRetryAfter(body)));
      res = await fetch(
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
    }
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

const round2 = (n: number) => Math.round(n * 100) / 100;

// Converts a local calendar-day boundary in the tenant's timezone to the exact
// UTC instant. ServiceTitan REPORTS run in the tenant's local timezone, but the
// Telecom API filters on UTC — so without this, the call window is shifted by the
// timezone offset and the count won't match the Call Center report.
function localBoundaryToUtc(date: string, endOfDay: boolean, timeZone: string): string {
  const time = endOfDay ? "23:59:59" : "00:00:00";
  const asUtc = new Date(`${date}T${time}Z`);
  const inTz = new Date(asUtc.toLocaleString("en-US", { timeZone }));
  const inUtc = new Date(asUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  const offsetMs = inUtc.getTime() - inTz.getTime();
  return new Date(asUtc.getTime() + offsetMs).toISOString();
}

// "Invoice Summary by Business Unit" (report 3201, accounting category). IMPORTANT:
// this report can only show invoices that have a Business Unit assigned -- any
// invoice without one is silently dropped, even if it has real revenue. Verified
// against this account: it undercounted June revenue by ~$28,640 across 71 real
// invoices missing a clean BU tag. So `byBusinessUnit` here is reliable for the
// per-department breakdown, but `total` must NOT be used as the company-wide
// revenue figure -- use getTotalRevenue() for that instead.
// Row shape: [BusinessUnit, Number, Subtotal, DiscountTotal, FeeTotal, Tax, Total,
// Status, IsPrevailingWageJob].
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
  for (const bu in byBusinessUnit) byBusinessUnit[bu] = round2(byBusinessUnit[bu]);
  return { total: round2(total), byBusinessUnit };
}

// "Invoice Detail by Date" (report 363, accounting category) — unlike report 3201,
// this includes every invoice regardless of whether it has a Business Unit assigned,
// so it's the correct source for a true company-wide revenue total. It has no
// business-unit column at all, so it can't provide a per-unit breakdown.
// Row shape: [InvoiceDate, Number, CustomerName, LocationAddress, LocationCity,
// LocationState, LocationZip, JobType, Zone, Subtotal, Tax, Total, IsPrevailingWageJob].
export async function getTotalRevenue(
  creds: STCredentials,
  from: string,
  to: string
): Promise<number> {
  const rows = await runReport(creds, "accounting", 363, [
    { name: "DateType", value: 0 },
    { name: "From", value: from },
    { name: "To", value: to },
  ]);
  let total = 0;
  for (const row of rows) total += Number(row[11]) || 0;
  return round2(total);
}

// All jobs currently in Scheduled status — matches the "Scheduled" count on the
// ST Dispatch Board. No date filter so it includes all open scheduled jobs.
export async function getTodaysOpportunities(
  creds: STCredentials,
  today: string
): Promise<number> {
  const data = await stFetch(
    creds,
    `/jpm/v2/tenant/${creds.stTenantId}/jobs?jobStatus=Scheduled&pageSize=1&includeTotal=true`
  );
  return data.totalCount ?? 0;
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

export interface STCloseRateByBU {
  closeRate: number;
  mtdSales: number;
  closedJobs: number;
  soldHours: number;
  mtdOpps: number;
}

// Inbound call count for the period — matches the "Calls Taken" column in the
// ST Calls report. direction=Inbound excludes outbound calls made by staff,
// keeping the count consistent with what the CSR report shows.
export async function getCallsRan(
  creds: STCredentials,
  from: string,
  to: string,
  timeZone: string
): Promise<number> {
  const after = localBoundaryToUtc(from, false, timeZone); // local start-of-day -> UTC
  const before = localBoundaryToUtc(to, true, timeZone); // local end-of-day -> UTC
  const data = await stFetch(
    creds,
    `/telecom/v2/tenant/${creds.stTenantId}/calls` +
      `?createdOnOrAfter=${encodeURIComponent(after)}` +
      `&createdOnOrBefore=${encodeURIComponent(before)}` +
      `&direction=Inbound&pageSize=1&includeTotal=true`
  );
  return data.totalCount ?? 0;
}

// Paginates all estimates for the period, groups by business unit name, and
// returns close rate, MTD sales dollars, sold hours, and opps per BU.
//
// MTD Opps / Close Rate: based on estimates CREATED this month (new pipeline).
// MTD Sales $ / Sold Hours: based on estimates SOLD this month (revenue recognised
// this month, including estimates written before the period and closed in it) —
// this matches ServiceTitan's Sales report "Total Sales" column.
export async function getCloseRateByBU(
  creds: STCredentials,
  from: string,
  to: string
): Promise<Record<string, STCloseRateByBU>> {
  const token = await getAccessToken(creds);

  async function paginateEstimates(queryStr: string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const res = await fetch(
        `${API_BASE}/sales/v2/tenant/${creds.stTenantId}/estimates?${queryStr}&pageSize=500&page=${page}`,
        { headers: { Authorization: `Bearer ${token}`, "ST-App-Key": creds.appKey } }
      );
      if (!res.ok) throw new Error(`Estimates error (${res.status}): ${await res.text()}`);
      const json = await res.json();
      out.push(...(json.data ?? []));
      hasMore = json.hasMore ?? false;
      page++;
    }
    return out;
  }

  const [created, soldThisMonth] = await Promise.all([
    paginateEstimates(`createdOnOrAfter=${from}T00:00:00Z`),
    paginateEstimates(`soldOnOrAfter=${from}T00:00:00Z`),
  ]);

  // MTD Opps and close rate — from estimates created this month
  const oppsByBU: Record<string, { sold: number; dismissed: number; total: number }> = {};
  for (const est of created) {
    const bu = est.businessUnitName as string | null;
    if (!bu) continue;
    if (!oppsByBU[bu]) oppsByBU[bu] = { sold: 0, dismissed: 0, total: 0 };
    oppsByBU[bu].total++;
    const status = (est.status as { name?: string } | null)?.name;
    if (status === "Sold") oppsByBU[bu].sold++;
    else if (status === "Dismissed") oppsByBU[bu].dismissed++;
  }

  // MTD Sales $ and Sold Hours — from estimates sold this month
  const salesByBU: Record<string, { count: number; subtotal: number; soldHours: number }> = {};
  for (const est of soldThisMonth) {
    const bu = est.businessUnitName as string | null;
    if (!bu) continue;
    if (!salesByBU[bu]) salesByBU[bu] = { count: 0, subtotal: 0, soldHours: 0 };
    salesByBU[bu].count++;
    salesByBU[bu].subtotal += Number(est.subtotal) || 0;
    const items = (est.items as { qty?: number; sku?: { soldHours?: number } }[]) ?? [];
    for (const item of items) {
      salesByBU[bu].soldHours += (Number(item.sku?.soldHours) || 0) * (Number(item.qty) || 0);
    }
  }

  const allBUs = new Set([...Object.keys(oppsByBU), ...Object.keys(salesByBU)]);
  const result: Record<string, STCloseRateByBU> = {};
  for (const bu of allBUs) {
    const opps = oppsByBU[bu] ?? { sold: 0, dismissed: 0, total: 0 };
    const sales = salesByBU[bu] ?? { count: 0, subtotal: 0, soldHours: 0 };
    const closeable = opps.sold + opps.dismissed;
    result[bu] = {
      closeRate: closeable > 0 ? round2((opps.sold / closeable) * 100) : 0,
      mtdSales: round2(sales.subtotal),
      closedJobs: sales.count,
      soldHours: round2(sales.soldHours),
      mtdOpps: opps.total,
    };
  }
  return result;
}

// Count of active technicians in a given business unit — used for Install Crews.
export async function getInstallCrewCount(
  creds: STCredentials,
  installBuId: number
): Promise<number> {
  const data = await stFetch(
    creds,
    `/settings/v2/tenant/${creds.stTenantId}/technicians?businessUnitId=${installBuId}&active=true&pageSize=1&includeTotal=true`
  );
  return data.totalCount ?? 0;
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
