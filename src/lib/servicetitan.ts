import { decrypt } from "./crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Tenant timezone offset (hours behind UTC). Duncan BC = PDT = UTC-7 in summer.
// Update to UTC-8 (PST) in winter when daylight saving ends.
const TZ_OFFSET_HOURS = 7;

// Converts a local date string (YYYY-MM-DD) to UTC midnight of that local day.
function localStart(date: string): string {
  return `${date}T${String(TZ_OFFSET_HOURS).padStart(2, "0")}:00:00Z`;
}

// Converts a local date string to UTC end-of-day (23:59:59 local = next day TZ_OFFSET-1:59:59 UTC).
function localEnd(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  d.setDate(d.getDate() + 1);
  const next = d.toISOString().slice(0, 10);
  return `${next}T${String(TZ_OFFSET_HOURS - 1).padStart(2, "0")}:59:59Z`;
}

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

// Jobs scheduled for today in Scheduled status — approximates the ST Dispatch
// Board count for today.
// jobStatus is a single enum value — a comma-separated list fails ST model
// validation with a 400, and because stFetch throws on any non-2xx that took the
// ENTIRE refresh down (every field on the board blanked, not just this one).
// "Working" is not a ServiceTitan status either. Reverted to the known-good
// `Scheduled` while the valid enum members are confirmed; counting Dispatched /
// in-progress / Hold as well needs one request per status, summed.
export async function getTodaysOpportunities(
  creds: STCredentials,
  today: string
): Promise<number> {
  const data = await stFetch(
    creds,
    `/jpm/v2/tenant/${creds.stTenantId}/jobs` +
      `?appointmentStartsOnOrAfter=${localStart(today)}` +
      `&appointmentStartsBefore=${localEnd(today)}` +
      `&jobStatus=Scheduled&pageSize=1&includeTotal=true`
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
    `/jpm/v2/tenant/${creds.stTenantId}/jobs?businessUnitId=${businessUnitId}&jobStatus=Completed&completedOnOrAfter=${localStart(completedOnOrAfter)}&pageSize=1&includeTotal=true`
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
  to: string
): Promise<number> {
  // The Telecom API's `direction=Inbound` filter is silently ignored — it
  // returns every call, so the old totalCount read 113 (97 inbound + 16 outbound)
  // vs the ST Call Center report's ~100 "Calls Taken". Page the calls and count
  // inbound in code instead. The call payload is nested under leadCall (or
  // bookingCall on booking records), so read direction from there.
  const token = await getAccessToken(creds);
  let inbound = 0;
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const res = await fetch(
      `${API_BASE}/telecom/v2/tenant/${creds.stTenantId}/calls` +
        `?createdOnOrAfter=${localStart(from)}&createdOnOrBefore=${localEnd(to)}` +
        `&page=${page}&pageSize=500`,
      { headers: { Authorization: `Bearer ${token}`, "ST-App-Key": creds.appKey } }
    );
    if (!res.ok) throw new Error(`Calls error (${res.status}): ${await res.text()}`);
    const json = await res.json();
    for (const rec of (json.data ?? []) as Record<string, unknown>[]) {
      const inner =
        (rec.leadCall as { direction?: unknown } | null) ??
        (rec.bookingCall as { direction?: unknown } | null) ??
        (rec as { direction?: unknown });
      if (inner?.direction === "Inbound") inbound++;
    }
    hasMore = json.hasMore ?? false;
    page++;
  }
  return inbound;
}

// Paginates all estimates for the period, groups by business unit name, and
// returns close rate, MTD sales dollars, sold hours, and opps per BU.
//
// MTD Opps / Close Rate: based on estimates CREATED this month (new pipeline).
// MTD Sales $ / Sold Hours: based on estimates SOLD this month (revenue recognised
// this month, including estimates written before the period and closed in it) —
// this matches ServiceTitan's Sales report "Total Sales" column.
// Sold hours come from INVOICE items, not estimates. ST report 414 shows 67
// completed jobs against just 17 sold estimates — ~50 jobs (75%) are invoiced
// with no estimate at all, so an estimate-based sum structurally cannot see their
// hours. That was the whole gap: 126.44 against ST's 215.13, i.e. 88.69h spread
// over ~50 jobs (~1.8h each, a routine service call).
//
// Invoice items expose soldHours directly and are job-based, so every job counts.
// Verified populated on live invoices (e.g. "DIAPA" qty 1, soldHours 1 on Jul 15);
// the nulls are legacy 2025 imports.
//
// Note the two dead ends: reports "Sold Hours" (87634674) and "Hours" (31940251)
// are TIMESHEET reports despite their names — every field is clock time
// (DurationDec, TimesheetActivity), which is what Reed explicitly says sold hours
// is NOT. Report 3300 has Price/Quantity but no hours column.
//
// invoicedOnOrAfter is verified real (year-2100 probe -> 0). invoiceDateOnOrAfter
// is NOT — it returns all 10,785 invoices — so it must never be used here.
export async function getSoldHours(
  creds: STCredentials,
  from: string,
  to: string
): Promise<number> {
  const token = await getAccessToken(creds);
  let total = 0;
  let page = 1;
  let hasMore = true;

  // invoiceDate is date-only (stored as UTC midnight, e.g. 2026-07-15T00:00:00Z),
  // so compare plain YYYY-MM-DD. Applying the tenant-local 07:00Z offset here
  // would silently drop the first day of the range.
  while (hasMore) {
    const res = await fetch(
      `${API_BASE}/accounting/v2/tenant/${creds.stTenantId}/invoices` +
        `?invoicedOnOrAfter=${from}T00:00:00Z&page=${page}&pageSize=200`,
      { headers: { Authorization: `Bearer ${token}`, "ST-App-Key": creds.appKey } }
    );
    if (!res.ok) throw new Error(`Invoices error (${res.status}): ${await res.text()}`);
    const json = await res.json();

    for (const inv of (json.data ?? []) as {
      invoiceDate?: unknown;
      items?: { soldHours?: unknown; quantity?: unknown }[];
    }[]) {
      // Never trust the filter to have been applied — that assumption caused the
      // 148x over-count and the 400 outage.
      const day = typeof inv.invoiceDate === "string" ? inv.invoiceDate.slice(0, 10) : "";
      if (day && (day < from || day > to)) continue;
      for (const item of inv.items ?? []) {
        total += (Number(item.soldHours) || 0) * (Number(item.quantity) || 0);
      }
    }
    hasMore = json.hasMore ?? false;
    page++;
  }
  return round2(total);
}

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

  // Opps + close rate: estimates CREATED in the period (this month's new
  // pipeline). createdOnOrAfter is verified real — a year-2100 probe returns 0.
  const created = await paginateEstimates(`createdOnOrAfter=${localStart(from)}`);

  // Sales $ + sold hours: estimates SOLD in the period. This is the basis ST's
  // Sales report uses, so an estimate written in June and sold in July counts —
  // deriving these from the CREATED set instead read 43% low (121.65 vs 215.13).
  //
  // soldAfter/soldBefore are verified real (year-2100 -> 0, year-1900 -> 0).
  // `soldOnOrAfter` — used here previously — is NOT a real filter: ST silently
  // ignores unknown params, so it returned all 2,523 estimates ever, which at
  // ~12.6h each is exactly the bogus 31,803 sold hours the board showed.
  // Both bounds are exclusive, so widen by 1s and let the check below decide.
  const shift = (iso: string, ms: number) =>
    new Date(new Date(iso).getTime() + ms).toISOString();
  const startMs = new Date(localStart(from)).getTime();
  const endMs = new Date(localEnd(to)).getTime();

  const soldRaw = await paginateEstimates(
    `soldAfter=${encodeURIComponent(shift(localStart(from), -1000))}` +
      `&soldBefore=${encodeURIComponent(shift(localEnd(to), 1000))}`
  );

  // Never trust a filter to have been applied — that assumption caused both the
  // 148x over-count and the 400 outage. status.name is a confirmed field.
  const sold = soldRaw.filter((est) => {
    if ((est.status as { name?: string } | null)?.name !== "Sold") return false;
    const soldOn = est.soldOn;
    if (typeof soldOn !== "string") return true;
    const t = new Date(soldOn).getTime();
    return !Number.isFinite(t) || (t >= startMs && t <= endMs);
  });

  type BUAgg = {
    oppsTotal: number;
    oppsSold: number;
    oppsDismissed: number;
    salesCount: number;
    subtotal: number;
    soldHours: number;
  };
  const byBU: Record<string, BUAgg> = {};
  const ensure = (bu: string): BUAgg =>
    (byBU[bu] ??= {
      oppsTotal: 0,
      oppsSold: 0,
      oppsDismissed: 0,
      salesCount: 0,
      subtotal: 0,
      soldHours: 0,
    });

  for (const est of created) {
    const bu = est.businessUnitName as string | null;
    if (!bu) continue;
    const agg = ensure(bu);
    agg.oppsTotal++;
    const status = (est.status as { name?: string } | null)?.name;
    if (status === "Sold") agg.oppsSold++;
    else if (status === "Dismissed") agg.oppsDismissed++;
  }

  for (const est of sold) {
    const bu = est.businessUnitName as string | null;
    if (!bu) continue;
    const agg = ensure(bu);
    agg.salesCount++;
    agg.subtotal += Number(est.subtotal) || 0;
    const items = (est.items as { qty?: number; sku?: { soldHours?: number } }[]) ?? [];
    for (const item of items) {
      agg.soldHours += (Number(item.sku?.soldHours) || 0) * (Number(item.qty) || 0);
    }
  }

  const result: Record<string, STCloseRateByBU> = {};
  for (const [bu, agg] of Object.entries(byBU)) {
    const closeable = agg.oppsSold + agg.oppsDismissed;
    result[bu] = {
      closeRate: closeable > 0 ? round2((agg.oppsSold / closeable) * 100) : 0,
      // Sales, closed jobs and sold hours all come from the SOLD set so that
      // Company Average Sale (sales / closedJobs) divides like with like.
      mtdSales: round2(agg.subtotal),
      closedJobs: agg.salesCount,
      soldHours: round2(agg.soldHours),
      mtdOpps: agg.oppsTotal,
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
