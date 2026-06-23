import { NextResponse } from "next/server";

// Placeholder for ServiceTitan's app registration form, which requires a
// Redirect URI even though our actual integration uses the client_credentials
// grant (server-to-server, no user-facing redirect ever happens here).
export async function GET() {
  return NextResponse.json({ status: "ok" });
}
