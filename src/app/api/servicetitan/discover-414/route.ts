import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSupabase } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

// Read-only probe. ServiceTitan silently ignores unknown query params instead of
// erroring, so every filter must be proven to actually narrow results before it
// is trusted. The technique: pass an absurd year-2100 bound — a real filter
// returns 0, an ignored one returns the unfiltered total.
//
// Already established by v2:
//   scheduledOnOrAfter            -> IGNORED (2100 still returned 156)
//   firstAppointmentStartsOnOrAfter -> real (2100 returned 0)
//   appointmentStartsOnOrAfter      -> real (2100 returned 0)
//
// Open: the companion upper bounds, and whether soldAfter/soldBefore are real
// (sold hours must move off the created-date basis, which reads 43% low).
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: cred } = await getSupabase()
    .from("crm_credentials")
    .select("st_tenant_id, app_key, client_id, client_secret_encrypted, connected")
    .eq("tenant_id", session.user.tenantId)
    .eq("provider", "servicetitan")
    .single();

  if (!cred?.connected) {
    return NextResponse.json({ error: "ServiceTitan not connected" }, { status: 400 });
  }

  const tokenRes = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cred.client_id,
      client_secret: decrypt(cred.client_secret_encrypted),
    }),
  });
  const { access_token } = await tokenRes.json();
  const headers = { Authorization: `Bearer ${access_token}`, "ST-App-Key": cred.app_key };
  const stId = cred.st_tenant_id;

  // Returns just enough to judge a filter: status + how many rows it matched.
  async function count(path: string) {
    const res = await fetch(`${API_BASE}${path}`, { headers });
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      return { status: res.status, totalCount: j.totalCount ?? null, error: j.title ?? null };
    } catch {
      return { status: res.status, totalCount: null, error: body.slice(0, 200) };
    }
  }

  const jobs = `/jpm/v2/tenant/${stId}/jobs`;
  const est = `/sales/v2/tenant/${stId}/estimates`;
  const sched = `&jobStatus=Scheduled&pageSize=1&includeTotal=true`;
  const p1 = `pageSize=1&includeTotal=true`;

  // Local (America/Vancouver) day boundaries for today, 2026-07-15 => UTC.
  const todayStart = "2026-07-15T07:00:00Z";
  const tomorrowStart = "2026-07-16T07:00:00Z";

  return NextResponse.json({
    note: "A filter is REAL if the year-2100 probe returns 0. It is IGNORED if it returns the same total as the unfiltered baseline. todaysOpportunities_* are the candidate real counts for today — compare against the ST Dispatch Board.",

    jobs_baseline_scheduled: await count(`${jobs}?${p1}&jobStatus=Scheduled`),

    // Which upper-bound param name is real?
    jobs_appointmentStartsBefore_1900: await count(
      `${jobs}?appointmentStartsBefore=1900-01-01T00:00:00Z${sched}`
    ),
    jobs_firstAppointmentStartsBefore_1900: await count(
      `${jobs}?firstAppointmentStartsBefore=1900-01-01T00:00:00Z${sched}`
    ),

    // The actual candidate answers for "Today's Opportunities".
    todaysOpportunities_anyAppointmentToday: await count(
      `${jobs}?appointmentStartsOnOrAfter=${todayStart}&appointmentStartsBefore=${tomorrowStart}${sched}`
    ),
    todaysOpportunities_firstAppointmentToday: await count(
      `${jobs}?firstAppointmentStartsOnOrAfter=${todayStart}&firstAppointmentStartsBefore=${tomorrowStart}${sched}`
    ),

    // ---- Estimates: are the sold-date filters real? --------------------------
    estimates_baseline: await count(`${est}?${p1}`),
    estimates_soldAfter_2100: await count(`${est}?soldAfter=2100-01-01T00:00:00Z&${p1}`),
    estimates_soldBefore_1900: await count(`${est}?soldBefore=1900-01-01T00:00:00Z&${p1}`),
    estimates_soldOnOrAfter_2100_knownBad: await count(
      `${est}?soldOnOrAfter=2100-01-01T00:00:00Z&${p1}`
    ),
    estimates_createdOnOrAfter_2100: await count(
      `${est}?createdOnOrAfter=2100-01-01T00:00:00Z&${p1}`
    ),
    // Does a status filter exist, and is it real?
    estimates_status_Sold: await count(`${est}?status=Sold&${p1}`),
    estimates_activeOnly: await count(`${est}?active=True&${p1}`),
  });
}
