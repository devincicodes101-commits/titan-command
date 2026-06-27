import { NextResponse } from "next/server";

// Placeholder for Jobber's OAuth app registration form, which requires a working
// Redirect URI before an app (and its Client ID/Secret) can even be created.
// Once Jobber redirects here with a real ?code=, this route will exchange it
// for an access/refresh token pair -- that part needs the app's Client ID/Secret
// first, so it isn't built yet.
export async function GET() {
  return NextResponse.json({ status: "ok" });
}
