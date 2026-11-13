import { DurableObject } from "cloudflare:workers";
import config from "../source.config.json";
import {
  buildFeed, GitHub, MAX_STALE_MS, REFRESH_MS, RETRY_MS, UpstreamError,
  type Feed, type MetadataCache,
} from "./feed";

interface Snapshot {
  feed?: Feed;
  metadata: MetadataCache;
  updatedAt: number;
  nextAttemptAt: number;
  failure?: string;
}

export interface FeedResult {
  body: string | null;
  updatedAt: number;
  stale: boolean;
  retryAfter: number;
  failure?: string;
}

// Resource bindings come from `wrangler types`.
// GitHub authentication is optional and never changes the upstream allowlist.
type WorkerEnv = Env & { GITHUB_TOKEN?: string };

export class FeedCache extends DurableObject<WorkerEnv> {
  private inFlight: Promise<FeedResult> | undefined;

  getFeed(): Promise<FeedResult> {
    // One instance represents one fixed feed. Every data center uses the same name.
    this.inFlight ??= this.readOrRefresh().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async readOrRefresh(): Promise<FeedResult> {
    const snapshot = await this.ctx.storage.get<Snapshot>("snapshot") ?? {
      metadata: {}, updatedAt: 0, nextAttemptAt: 0,
    };
    const now = Date.now();
    if (now < snapshot.nextAttemptAt) return this.result(snapshot, now);

    // Persist the cooldown before external I/O, so an eviction/restart cannot bypass it.
    snapshot.nextAttemptAt = now + RETRY_MS;
    await this.ctx.storage.put("snapshot", snapshot);
    try {
      const generated = await buildFeed(new GitHub(this.env.GITHUB_TOKEN, fetch, Date.now,
        () => this.reserveRequest()),
        snapshot.metadata, snapshot.feed);
      const updatedAt = Date.now();
      const next: Snapshot = {
        ...generated, updatedAt, nextAttemptAt: updatedAt + REFRESH_MS,
      };
      await this.ctx.storage.put("snapshot", next);
      return this.result(next, updatedAt);
    } catch (error) {
      if (error instanceof UpstreamError) {
        snapshot.nextAttemptAt = Math.max(snapshot.nextAttemptAt, now + error.retryAfter);
      }
      snapshot.failure = error instanceof UpstreamError
        ? error.status ? `github-http-${error.status}` : "upstream-unavailable"
        : "invalid-upstream";
      await this.ctx.storage.put("snapshot", snapshot);
      // Do not log the incoming request, Authorization header, or upstream body.
      console.warn(JSON.stringify({ event: "feed_refresh_failed",
        reason: snapshot.failure }));
      return this.result(snapshot, Date.now());
    }
  }

  private async reserveRequest(): Promise<void> {
    const now = Date.now();
    const hour = 3_600_000;
    const previous = await this.ctx.storage.get<number[]>("upstream-requests") ?? [];
    const recent = previous.filter((time) => time > now - hour);
    const limit = this.env.GITHUB_TOKEN ? 300 : 40;
    if (recent.length >= limit) {
      throw new UpstreamError("Upstream hourly budget exhausted", recent[0] + hour - now);
    }
    recent.push(now);
    await this.ctx.storage.put("upstream-requests", recent);
  }

  private result(snapshot: Snapshot, now: number): FeedResult {
    const usable = snapshot.feed && now - snapshot.updatedAt <= MAX_STALE_MS;
    return {
      body: usable ? JSON.stringify(snapshot.feed) : null,
      updatedAt: snapshot.updatedAt,
      stale: now - snapshot.updatedAt >= REFRESH_MS,
      retryAfter: Math.max(1, Math.ceil((snapshot.nextAttemptAt - now) / 1000)),
      failure: snapshot.failure,
    };
  }
}

function headers(publicFeed = false): Headers {
  return new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": publicFeed ? "public, max-age=0, must-revalidate" : "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
}

function errorResponse(status: number, message: string, head = false): Response {
  return new Response(head ? null : JSON.stringify({ error: message }), {
    status, headers: headers(),
  });
}

async function handle(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const head = request.method === "HEAD";
  const url = new URL(request.url);
  // Query strings are never cache keys or upstream selectors. Reject them outright.
  if (url.search || url.hash) return errorResponse(400, "Query parameters are not supported", head);
  if (url.pathname !== "/apps.json") return errorResponse(404, "Not found", head);
  if (request.method !== "GET" && !head) {
    const response = errorResponse(405, "Method not allowed");
    response.headers.set("Allow", "GET, HEAD");
    return response;
  }
  // Anyone can subscribe. Cloudflare's client IP header only groups abusive requests;
  // it never decides which clients or upstream repositories may access the feed.
  // This edge limiter is approximate; the Durable Object strictly bounds upstream refreshes.
  const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
  const limit = await env.REQUEST_LIMITER.limit({
    key: `${config.source.identifier}:${clientIP}`,
  });
  if (!limit.success) {
    const response = errorResponse(429, "Too many requests", head);
    response.headers.set("Retry-After", "60");
    return response;
  }

  // Every subscriber shares this internal key; headers cannot select another source.
  const cacheKey = new Request(`https://${url.host}/__internal/feather-feed-v1`, { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const responseHeaders = headers(true);
    for (const name of ["X-Source-Updated-At", "X-Source-Stale"]) {
      const value = cached.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(head ? null : cached.body, { headers: responseHeaders });
  }

  const result = await env.FEED.getByName(config.source.identifier).getFeed();
  if (!result.body) {
    const response = errorResponse(503, "Upstream temporarily unavailable", head);
    response.headers.set("Retry-After", String(result.retryAfter));
    response.headers.set("X-Source-Status", result.failure ?? "waiting-for-refresh");
    return response;
  }
  const responseHeaders = headers(true);
  responseHeaders.set("X-Source-Updated-At", new Date(result.updatedAt).toISOString());
  responseHeaders.set("X-Source-Stale", String(result.stale));
  const storedHeaders = new Headers(responseHeaders);
  // Never let an edge cache outlive the global refresh deadline.
  const edgeTTL = Math.min(30, result.retryAfter);
  storedHeaders.set("Cache-Control", `public, max-age=${edgeTTL}`);
  ctx.waitUntil(caches.default.put(cacheKey,
    new Response(result.body, { headers: storedHeaders })).catch(() => {
    console.warn(JSON.stringify({ event: "edge_cache_write_failed" }));
  }));
  return new Response(head ? null : result.body, { headers: responseHeaders });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await handle(request, env, ctx);
    } catch {
      console.error(JSON.stringify({ event: "request_failed" }));
      return errorResponse(503, "Source temporarily unavailable", request.method === "HEAD");
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
