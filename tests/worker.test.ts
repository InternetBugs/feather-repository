import { env } from "cloudflare:workers";
import {
  createExecutionContext, evictDurableObject, reset, runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import config from "../source.config.json";
import worker from "../src/index";
import {
  boundedJson, buildFeed, GitHub, MAX_STALE_MS, REFRESH_MS, RETRY_MS,
  UpstreamError, validateDownloadURL, type Fetcher,
} from "../src/feed";

const FEED_URL = "https://source.example/apps.json";
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function fixtureRelease(app: number, index: number) {
  const spec = config.apps[app];
  const tag = app === 0 ? `2.2.0.${index}` : `v0.5.${index}`;
  const name = app === 0 ? `PiliPlus_ios_2.2.0+${5590 + index}.ipa` : "BahaPlus-iOS-unsigned.ipa";
  return {
    tag_name: tag,
    published_at: `2026-11-${10 + index}T08:00:00Z`,
    html_url: `https://github.com/${spec.repo}/releases/tag/${tag}`,
    body: `版本 ${index}`,
    draft: false,
    prerelease: false,
    assets: [{
      id: app * 10 + index,
      name,
      size: 12345,
      updated_at: `2026-11-${10 + index}T08:01:00Z`,
      state: "uploaded",
      digest: `sha256:${"b".repeat(64)}`,
      browser_download_url: `https://github.com/${spec.repo}/releases/download/${tag}/${encodeURIComponent(name)}`,
    }],
  };
}

function fixtures() {
  return config.apps.map((_, app) => [1, 3, 2].map((index) => fixtureRelease(app, index)));
}

function fakeGitHub(data = fixtures()) {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const fetcher: Fetcher = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push({ url, init });
    expect(url.origin).toBe("https://api.github.com");
    expect(init?.redirect).toBe("manual");
    const app = config.apps.findIndex((spec) => url.pathname.startsWith(`/repos/${spec.repo}/`));
    if (app === -1) throw new Error(`Unexpected repository: ${url.pathname}`);
    const spec = config.apps[app];
    if (url.pathname === `/repos/${spec.repo}/releases`) return Response.json(data[app]);
    const prefix = `/repos/${spec.repo}/contents/`;
    const path = url.pathname.slice(prefix.length);
    let content: string;
    if (path === spec.iosProjectPath) {
      const bundle = app === 0 ? "com.example.piliplus" : "app.bahaplus.mobile";
      content = `PRODUCT_BUNDLE_IDENTIFIER = ${bundle};\n`
        + `PRODUCT_BUNDLE_IDENTIFIER = ${bundle}.RunnerTests;\n`
        + "IPHONEOS_DEPLOYMENT_TARGET = 15.0;\n";
    } else if (app === 1 && path === "tools/release_version.py") {
      content = "build_number = major * 1_000_000 + minor * 1_000 + patch";
    } else if (app === 1 && path === ".github/workflows/release.yml") {
      content = 'flutter build ios --build-name "$RELEASE_VERSION" --build-number "$BUILD_NUMBER"';
    } else {
      throw new Error(`Unexpected source file: ${path}`);
    }
    return Response.json({ type: "file", encoding: "base64", content: btoa(content) });
  };
  return { requests, fetcher };
}

async function request(url = FEED_URL, init?: RequestInit<IncomingRequestCfProperties>,
  overrides: Partial<Env> = {}) {
  const context = createExecutionContext();
  const response = await worker.fetch(new IncomingRequest(url, init),
    { ...env, ...overrides }, context);
  await waitOnExecutionContext(context);
  return response;
}

function stub() {
  return env.FEED.getByName(config.source.identifier);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("public subscription and route restrictions", () => {
  it.each([
    "/", "/__internal/feather-feed-v1", "/download", "/apps.json/",
    "/https://example.com/", `/${"b".repeat(64)}/apps.json`,
    "/attacker/repo/apps.json", "/repos/attacker/repo/releases",
  ])("rejects unknown path %s without upstream access", async (path) => {
    const outgoing = vi.spyOn(globalThis, "fetch");
    const result = await request(`https://source.example${path}`);
    expect(result.status).toBe(404);
    expect(outgoing).not.toHaveBeenCalled();
  });

  it.each(["?repo=attacker/repo", "?url=https://example.com", "?refresh=1", "?t=123"])(
    "rejects query parameter %s without upstream access", async (query) => {
      const outgoing = vi.spyOn(globalThis, "fetch");
      expect((await request(FEED_URL + query)).status).toBe(400);
      expect(outgoing).not.toHaveBeenCalled();
    });

  it.each(["POST", "PUT", "DELETE", "OPTIONS"])("rejects %s", async (method) => {
    const outgoing = vi.spyOn(globalThis, "fetch");
    const result = await request(FEED_URL, { method });
    expect(result.status).toBe(405);
    expect(result.headers.get("Allow")).toBe("GET, HEAD");
    expect(outgoing).not.toHaveBeenCalled();
  });

  it("allows public GET requests without a token or client IP", async () => {
    const fixture = fakeGitHub();
    vi.spyOn(globalThis, "fetch").mockImplementation(fixture.fetcher);
    const result = await request();
    expect(result.status).toBe(200);
    expect(result.headers.has("WWW-Authenticate")).toBe(false);
    expect(result.headers.has("Set-Cookie")).toBe(false);
    expect((await result.json() as { apps: unknown[] }).apps).toHaveLength(2);
  });

  it("limits each client independently and ignores forwarded IP claims", async () => {
    const fixture = fakeGitHub();
    vi.spyOn(globalThis, "fetch").mockImplementation(fixture.fetcher);
    const limit = vi.fn(async (_options: { key: string }) => ({ success: true }));
    for (const [clientIP, forwarded] of [
      ["203.0.113.2", "198.51.100.8"],
      ["2001:db8::1", "198.51.100.8"],
      ["203.0.113.2", "192.0.2.1"],
    ]) {
      const result = await request(FEED_URL, {
        headers: { "CF-Connecting-IP": clientIP, "X-Forwarded-For": forwarded },
      }, { REQUEST_LIMITER: { limit } });
      expect(result.status).toBe(200);
    }
    expect(limit.mock.calls.map(([options]) => options.key)).toEqual([
      `${config.source.identifier}:203.0.113.2`,
      `${config.source.identifier}:2001:db8::1`,
      `${config.source.identifier}:203.0.113.2`,
    ]);
    expect(fixture.requests).toHaveLength(14);
  });

  it("returns 429 before querying GitHub when the rate limit is exhausted", async () => {
    const outgoing = vi.spyOn(globalThis, "fetch");
    const result = await request(FEED_URL, undefined, {
      REQUEST_LIMITER: { limit: async () => ({ success: false }) },
    });
    expect(result.status).toBe(429);
    expect(result.headers.get("Retry-After")).toBe("60");
    expect(outgoing).not.toHaveBeenCalled();
  });
});

describe("feed generation and outbound whitelist", () => {
  it("keeps three versions, uses IPA version/build, and emits matching legacy fields", async () => {
    const fixture = fakeGitHub();
    const result = await buildFeed(new GitHub(undefined, fixture.fetcher), {});
    const [pili, baha] = result.feed.apps;
    expect(pili.versions).toHaveLength(3);
    expect(pili.version).toBe("2.2.0");
    expect(pili.versions[0].buildVersion).toBe("5593");
    expect(pili.versions[0].releaseTag).toBe("2.2.0.3");
    expect(baha.versions[0].buildVersion).toBe("5003");
    for (const app of result.feed.apps) {
      expect(app.downloadURL).toBe(app.versions[0].downloadURL);
      expect(app.size).toBe(app.versions[0].size);
      expect(app.versionDate).toBe(app.versions[0].date);
      expect(app.versionDescription).toBe(app.versions[0].localizedDescription);
      expect(app.iconURL).toContain("/Icon-App-1024x1024%401x.png");
    }
    expect(fixture.requests).toHaveLength(14);
    expect(fixture.requests.every(({ url }) => !url.pathname.endsWith(".ipa"))).toBe(true);
  });

  it("reuses metadata without fetching tag source again", async () => {
    const fixture = fakeGitHub();
    const first = await buildFeed(new GitHub(undefined, fixture.fetcher), {});
    fixture.requests.length = 0;
    const second = await buildFeed(new GitHub(undefined, fixture.fetcher), first.metadata, first.feed);
    expect(second.feed).toEqual(first.feed);
    expect(fixture.requests).toHaveLength(2);
  });

  it("rejects arbitrary repositories, source paths, and encoded path traversal", async () => {
    const fixture = fakeGitHub();
    const github = new GitHub(undefined, fixture.fetcher);
    await expect(github.releases({ ...config.apps[0], repo: "attacker/repo" }))
      .rejects.toThrow("not allowlisted");
    await expect(github.text(config.apps[0], "../../secrets", "2.2.0"))
      .rejects.toThrow("not allowlisted");
    await expect(github.text(config.apps[0], config.apps[0].iosProjectPath, "../main"))
      .rejects.toThrow("Unsupported release tag");
    expect(fixture.requests).toHaveLength(0);
  });

  it.each([
    "https://example.com/app.ipa",
    "https://github.com.attacker.example/InternetBugs/Baha-Plus/releases/download/v0.5.3/BahaPlus-iOS-unsigned.ipa",
    "https://github.com/attacker/repo/releases/download/v0.5.3/BahaPlus-iOS-unsigned.ipa",
    "https://user@github.com/InternetBugs/Baha-Plus/releases/download/v0.5.3/BahaPlus-iOS-unsigned.ipa",
    "https://github.com/InternetBugs/Baha-Plus/releases/download/v0.5.3/BahaPlus-iOS-unsigned.ipa?redirect=https://example.com",
  ])("rejects an unsafe IPA URL %s", (url) => {
    expect(() => validateDownloadURL(url, config.apps[1].repo, "v0.5.3", "BahaPlus-iOS-unsigned.ipa"))
      .toThrow();
  });

  it("rejects duplicate assets and excludes draft/prerelease releases", async () => {
    const data = fixtures();
    const draft = { ...fixtureRelease(0, 4), draft: true };
    const beta = { ...fixtureRelease(0, 5), prerelease: true };
    data[0].push(draft, beta);
    const selected = await buildFeed(new GitHub(undefined, fakeGitHub(data).fetcher), {});
    expect(selected.feed.apps[0].versions[0].buildVersion).toBe("5593");
    data[0][0].assets.push({ ...data[0][0].assets[0] });
    await expect(buildFeed(new GitHub(undefined, fakeGitHub(data).fetcher), {}))
      .rejects.toThrow("Ambiguous IPA");
  });

  it("revalidates tag metadata when a release asset is replaced", async () => {
    const data = fixtures();
    const fixture = fakeGitHub(data);
    const first = await buildFeed(new GitHub(undefined, fixture.fetcher), {});
    fixture.requests.length = 0;
    data[0][0].assets[0].updated_at = "2026-11-13T09:00:00Z";
    await buildFeed(new GitHub(undefined, fixture.fetcher), first.metadata, first.feed);
    expect(fixture.requests).toHaveLength(3);
  });

  it("rejects upstream redirects rather than forwarding an authenticated request", async () => {
    const fetcher: Fetcher = async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-only");
      return new Response(null, { status: 302, headers: { Location: "https://attacker.example/" } });
    };
    await expect(new GitHub("test-only", fetcher).releases(config.apps[0]))
      .rejects.toThrow("GitHub HTTP 302");
  });

  it("bounds streamed upstream JSON even without Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('"oversized"'));
        controller.close();
      },
    });
    await expect(boundedJson(new Response(stream), 4)).rejects.toThrow("too large");
  });
});

describe("global cache, cooldown, and budget", () => {
  it("merges concurrent refreshes and keeps the cache after eviction", async () => {
    const fixture = fakeGitHub();
    vi.spyOn(globalThis, "fetch").mockImplementation(fixture.fetcher);
    const results = await Promise.all(Array.from({ length: 12 }, () => stub().getFeed()));
    expect(results.every((result) => result.body === results[0].body)).toBe(true);
    expect(results[0].stale).toBe(false);
    expect(fixture.requests).toHaveLength(14);
    await evictDurableObject(stub());
    expect((await stub().getFeed()).body).toBe(results[0].body);
    expect(fixture.requests).toHaveLength(14);
  });

  it("returns stale data on an upstream outage and backs off repeated requests", async () => {
    const fixture = fakeGitHub();
    const outgoing = vi.spyOn(globalThis, "fetch").mockImplementation(fixture.fetcher);
    const first = await stub().getFeed();
    await runInDurableObject(stub(), async (_instance, state) => {
      const snapshot = await state.storage.get<Record<string, unknown>>("snapshot");
      await state.storage.put("snapshot", {
        ...snapshot, updatedAt: Date.now() - REFRESH_MS - 1000, nextAttemptAt: 0,
      });
    });
    outgoing.mockResolvedValue(new Response(null, { status: 502 }));
    const stale = await stub().getFeed();
    expect(stale.body).toBe(first.body);
    expect(stale.stale).toBe(true);
    expect(stale.retryAfter).toBeGreaterThanOrEqual(RETRY_MS / 1000 - 2);
    outgoing.mockClear();
    await evictDurableObject(stub());
    await stub().getFeed();
    expect(outgoing).not.toHaveBeenCalled();
  });

  it("does not serve data older than 24 hours", async () => {
    const fixture = fakeGitHub();
    vi.spyOn(globalThis, "fetch").mockImplementation(fixture.fetcher);
    await stub().getFeed();
    await runInDurableObject(stub(), async (_instance, state) => {
      const snapshot = await state.storage.get<Record<string, unknown>>("snapshot");
      await state.storage.put("snapshot", {
        ...snapshot, updatedAt: Date.now() - MAX_STALE_MS - 1000,
        nextAttemptAt: Date.now() + RETRY_MS,
      });
    });
    expect((await stub().getFeed()).body).toBeNull();
  });

  it("strictly stops upstream requests at the shared hourly budget", async () => {
    const outgoing = vi.spyOn(globalThis, "fetch");
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put("upstream-requests", Array.from({ length: 40 }, () => Date.now()));
    });
    const result = await stub().getFeed();
    expect(result.body).toBeNull();
    expect(result.retryAfter).toBeGreaterThan(3500);
    expect(outgoing).not.toHaveBeenCalled();
  });

  it("respects GitHub's reset time after a rate limit response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 403,
      headers: { "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 1800) },
    }));
    const result = await stub().getFeed();
    expect(result.body).toBeNull();
    expect(result.retryAfter).toBeGreaterThanOrEqual(1798);
    expect(result.failure).toBe("github-http-403");
  });

  it("returns public JSON for GET and empty HEAD using the same shared cache", async () => {
    const fixture = fakeGitHub();
    const outgoing = vi.spyOn(globalThis, "fetch").mockImplementation(fixture.fetcher);
    const result = await request();
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(result.headers.get("Referrer-Policy")).toBe("no-referrer");
    const body = await result.text();
    expect(JSON.parse(body).apps).toHaveLength(2);
    outgoing.mockClear();
    const head = await request(FEED_URL, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const otherClient = await request(FEED_URL, {
      headers: { "CF-Connecting-IP": "198.51.100.8", Authorization: "Bearer ignored" },
    });
    expect(otherClient.status).toBe(200);
    expect(await otherClient.text()).toBe(body);
    expect(otherClient.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(outgoing).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 rather than a partial feed on first-build failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new UpstreamError("simulated outage"));
    const result = await request();
    expect(result.status).toBe(503);
    expect(Number(result.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await result.json()).toEqual({ error: "Upstream temporarily unavailable" });
  });
});
