/**
 * Browser cookie sync — fetches user cookies from the Dialogue API server
 * and injects them into the CamoFox browser session.
 *
 * On each MCP request, the HTTP handler checks whether the user has synced
 * browser cookies.  If they have (and the cookies are newer than the last
 * injection), they are fetched, decrypted by the API server, and injected
 * into the camofox-browser context via POST /sessions/:userId/cookies.
 *
 * This allows users to browse authenticated sites through camofox using
 * cookies synced from their local browser via the macOS app.
 */

import type { CamofoxClient } from "./client.js";

interface CookieStore {
  user_id: string;
  browser: string;
  domains: string[];
  cookie_count: number;
  synced_at: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: string;
  }>;
}

// Per-user tracking of when cookies were last injected.
const lastInjectedAt = new Map<string, string>();

/**
 * Fetch the user's browser cookies from the Dialogue API server and inject
 * them into their camofox-browser session.
 *
 * Only fetches cookies that are newer than the last injection (uses the
 * `since` query parameter).  No-ops if the API server URL is not configured
 * or the user has no stored cookies.
 */
export async function syncUserCookies(
  userId: string,
  client: CamofoxClient,
  apiServerUrl: string | undefined
): Promise<void> {
  if (!apiServerUrl) return;

  const since = lastInjectedAt.get(userId);
  const url = new URL(`/internal/browser-cookies/${encodeURIComponent(userId)}`, apiServerUrl);
  if (since) {
    url.searchParams.set("since", since);
  }

  let stores: CookieStore[];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      if (response.status === 404) {
        // No cookies stored — normal case
        return;
      }
      console.error(
        `[camofox-mcp] cookie-sync: API server returned ${response.status} for user ${userId}`
      );
      return;
    }

    stores = await response.json() as CookieStore[];
  } catch (error) {
    // Don't fail the MCP request because of a cookie fetch error.
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("AbortError") || msg.includes("abort")) {
      console.error(`[camofox-mcp] cookie-sync: timeout fetching cookies for user ${userId}`);
    } else {
      console.error(`[camofox-mcp] cookie-sync: failed to fetch cookies for user ${userId}: ${msg}`);
    }
    return;
  }

  if (!stores || stores.length === 0) {
    return;
  }

  // Merge all cookie stores into a single array.
  const allCookies: unknown[] = [];
  let latestSyncedAt = since ?? "";

  for (const store of stores) {
    if (store.cookies && store.cookies.length > 0) {
      allCookies.push(...store.cookies);
    }
    if (store.synced_at > latestSyncedAt) {
      latestSyncedAt = store.synced_at;
    }
  }

  if (allCookies.length === 0) {
    return;
  }

  try {
    await client.importCookies(userId, allCookies);
    lastInjectedAt.set(userId, latestSyncedAt);
    console.error(
      `[camofox-mcp] cookie-sync: injected ${allCookies.length} cookies for user ${userId} ` +
        `(from ${stores.length} browser${stores.length > 1 ? "s" : ""})`
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[camofox-mcp] cookie-sync: failed to inject cookies for user ${userId}: ${msg}`);
  }
}
