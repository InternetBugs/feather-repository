import config from "../source.config.json";

export const ALLOWED_REPOS = [
  "bggRGjQaUbCoE/PiliPlus",
  "InternetBugs/Baha-Plus",
] as const;

export const REFRESH_MS = 180_000;
export const RETRY_MS = 300_000;
export const MAX_STALE_MS = 86_400_000;
const MAX_API_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_REQUESTS = 24;
const MAX_METADATA_ENTRIES = 64;

type AppSpec = (typeof config.apps)[number];
export type JsonObject = Record<string, unknown>;
export type Fetcher = typeof fetch;
export type MetadataCache = Record<string, Metadata>;

export interface Metadata {
  bundleIdentifier: string;
  version: string;
  buildVersion: string;
  minOSVersion: string;
  sha256?: string;
}

interface Asset {
  id: number;
  name: string;
  size: number;
  updated_at: string;
  browser_download_url: string;
  digest?: string;
  state?: string;
}

interface Release {
  tag_name: string;
  published_at: string;
  html_url: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: Asset[];
}

export interface AppVersion extends Omit<Metadata, "bundleIdentifier"> {
  date: string;
  localizedDescription: string;
  downloadURL: string;
  size: number;
  releaseTag: string;
  source: string;
  metadataSource: string;
}

export interface FeedApp {
  name: string;
  developerName: string;
  subtitle: string;
  localizedDescription: string;
  tintColor: string;
  category: string;
  bundleIdentifier: string;
  website: string;
  iconURL: string;
  versions: AppVersion[];
  version: string;
  versionDate: string;
  versionDescription: string;
  downloadURL: string;
  size: number;
  minOSVersion: string;
}

export interface Feed {
  name: string;
  identifier: string;
  description: string;
  apps: FeedApp[];
  featuredApps: string[];
  news: never[];
}

export interface BuildResult {
  feed: Feed;
  metadata: MetadataCache;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly retryAfter = RETRY_MS,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(value: unknown): JsonObject {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value),
    "Invalid upstream object");
  return value as JsonObject;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function safeTag(tag: unknown): asserts tag is string {
  requireValue(typeof tag === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(tag),
    "Unsupported release tag");
}

function assertSpec(spec: AppSpec): void {
  requireValue(ALLOWED_REPOS.some((repo) => repo === spec.repo),
    "Repository is not allowlisted");
  const expected = config.apps.find((app) => app.repo === spec.repo);
  requireValue(expected && spec.iosProjectPath === expected.iosProjectPath
    && spec.versionStrategy === expected.versionStrategy
    && spec.assetPattern === expected.assetPattern && spec.iconPath === expected.iconPath,
  "Application paths or version rules are not allowlisted");
}

export function validateDownloadURL(value: string, repo: string, tag: string, name: string): void {
  requireValue(ALLOWED_REPOS.some((allowed) => allowed === repo),
    "Download repository is not allowlisted");
  safeTag(tag);
  requireValue(!name.includes("/") && !name.includes("\\") && name.endsWith(".ipa"),
    "Invalid IPA filename");
  const url = new URL(value);
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    throw new Error("Invalid download URL encoding");
  }
  requireValue(url.protocol === "https:" && url.hostname === "github.com"
    && !url.port && !url.username && !url.password && !url.search && !url.hash
    && path === `/${repo}/releases/download/${tag}/${name}`,
  "Download must be the exact allowlisted upstream IPA");
}

export async function boundedJson(response: Response, limit = MAX_API_BYTES): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Upstream response too large");
  }
  requireValue(response.body, "Empty upstream response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let length = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      requireValue(length <= limit, "Upstream response too large");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class GitHub {
  private requests = 0;
  private readonly deadline = Date.now() + 25_000;

  constructor(
    private readonly token?: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly clock: () => number = Date.now,
    private readonly reserveRequest: () => Promise<void> = async () => {},
  ) {}

  private async api(path: string): Promise<unknown> {
    requireValue(++this.requests <= MAX_REQUESTS, "Upstream request budget exceeded");
    requireValue(Date.now() < this.deadline, "Upstream refresh deadline exceeded");
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "User-Agent": "InternetBugs-Feather-Source",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    await this.reserveRequest();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),
      Math.max(1, Math.min(8_000, this.deadline - Date.now())));
    try {
      const fetcher = this.fetcher;
      const response = await fetcher(`https://api.github.com/${path}`, {
        headers,
        // Workers supports manual/follow; every 3xx is rejected by the status check below.
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        let delay = RETRY_MS;
        if (response.status === 403 || response.status === 429) {
          const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
          const retry = Number(response.headers.get("retry-after")) * 1000;
          delay = Math.min(3_600_000, Math.max(delay,
            Number.isFinite(reset) ? reset - this.clock() : 0,
            Number.isFinite(retry) ? retry : 0));
        }
        throw new UpstreamError(`GitHub HTTP ${response.status}`, delay, response.status);
      }
      return await boundedJson(response);
    } finally {
      clearTimeout(timer);
    }
  }

  async releases(spec: AppSpec): Promise<Release[]> {
    assertSpec(spec);
    const result: Release[] = [];
    for (let page = 1; page <= 3; page++) {
      const data = await this.api(`repos/${spec.repo}/releases?per_page=30&page=${page}`);
      requireValue(Array.isArray(data), "Invalid release list");
      for (const item of data) {
        const release = object(item);
        if (release.draft || release.prerelease || !release.published_at) continue;
        safeTag(release.tag_name);
        if (/(?:^|[-_.])(alpha|beta|rc|nightly|dev|preview)(?:\d|[-_.]|$)/i.test(release.tag_name)) {
          continue;
        }
        requireValue(timestamp(release.published_at) && Array.isArray(release.assets),
          "Invalid release metadata");
        requireValue(typeof release.body === "string" || release.body == null,
          "Invalid release notes");
        const assets: Asset[] = [];
        for (const rawAsset of release.assets) {
          const asset = object(rawAsset);
          if (typeof asset.name !== "string"
            || !new RegExp(spec.assetPattern, "i").test(asset.name)
            || (asset.state !== undefined && asset.state !== "uploaded")) continue;
          requireValue(Number.isSafeInteger(asset.id) && Number(asset.id) > 0
            && Number.isSafeInteger(asset.size) && Number(asset.size) > 0
            && timestamp(asset.updated_at) && typeof asset.browser_download_url === "string"
            && (asset.digest == null
              || (typeof asset.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(asset.digest))),
          "Invalid IPA metadata");
          validateDownloadURL(asset.browser_download_url, spec.repo, release.tag_name, asset.name);
          assets.push({
            id: Number(asset.id),
            name: asset.name,
            size: Number(asset.size),
            updated_at: asset.updated_at,
            browser_download_url: asset.browser_download_url,
            ...(typeof asset.digest === "string" ? { digest: asset.digest } : {}),
          });
        }
        requireValue(assets.length <= 1, "Ambiguous IPA assets");
        if (!assets.length) continue;
        const source = `https://github.com/${spec.repo}/releases/tag/${encodeURIComponent(release.tag_name)}`;
        result.push({
          tag_name: release.tag_name,
          published_at: release.published_at,
          html_url: source,
          body: typeof release.body === "string" ? release.body : undefined,
          assets,
        });
      }
      if (result.length >= config.versionsToKeep || data.length < 30) break;
    }
    result.sort((left, right) => Date.parse(right.published_at) - Date.parse(left.published_at));
    requireValue(result.length > 0, "No stable release with an allowlisted IPA");
    return result;
  }

  async text(spec: AppSpec, path: string, tag: string): Promise<string> {
    assertSpec(spec);
    safeTag(tag);
    const allowed = [spec.iosProjectPath];
    if (spec.versionStrategy === "baha-tag") {
      allowed.push("tools/release_version.py", ".github/workflows/release.yml");
    }
    requireValue(allowed.includes(path), "Source path is not allowlisted");
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const value = object(await this.api(
      `repos/${spec.repo}/contents/${encodedPath}?ref=${encodeURIComponent(tag)}`,
    ));
    requireValue(value.type === "file" && value.encoding === "base64"
      && typeof value.content === "string" && value.content.length <= MAX_TEXT_BYTES * 2,
    "Invalid source file");
    const raw = atob(value.content.replace(/\s/g, ""));
    requireValue(raw.length <= MAX_TEXT_BYTES, "Source file too large");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(raw, (character) => character.charCodeAt(0)),
    );
  }
}

async function metadataFor(spec: AppSpec, release: Release, github: GitHub): Promise<Metadata> {
  const project = await github.text(spec, spec.iosProjectPath, release.tag_name);
  const bundles = new Set(
    [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([\w.-]+)"?\s*;/g)]
      .map((match) => match[1]).filter((bundle) => !/\.(RunnerTests|Tests)$/.test(bundle)),
  );
  const minimums = new Set(
    [...project.matchAll(/IPHONEOS_DEPLOYMENT_TARGET\s*=\s*"?(\d+(?:\.\d+){0,2})"?\s*;/g)]
      .map((match) => match[1]),
  );
  requireValue(bundles.size === 1 && minimums.size === 1,
    "Ambiguous bundle identifier or minimum iOS version");
  let version: string;
  let buildVersion: string;
  if (spec.versionStrategy === "pili-asset") {
    const match = /^PiliPlus_ios_(\d+\.\d+\.\d+)\+(\d+)\.ipa$/.exec(release.assets[0].name);
    requireValue(match, "Unrecognized PiliPlus IPA filename");
    [, version, buildVersion] = match;
  } else {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(release.tag_name);
    requireValue(match, "Unrecognized Baha Plus tag");
    const script = await github.text(spec, "tools/release_version.py", release.tag_name);
    requireValue(
      /build_number\s*=\s*major\s*\*\s*1_000_000\s*\+\s*minor\s*\*\s*1_000\s*\+\s*patch/.test(script),
      "Baha Plus build number formula changed",
    );
    const workflow = await github.text(spec, ".github/workflows/release.yml", release.tag_name);
    requireValue(workflow.includes('--build-name "$RELEASE_VERSION" --build-number "$BUILD_NUMBER"'),
      "Baha Plus build arguments changed");
    const [major, minor, patch] = match.slice(1).map(Number);
    const build = major * 1_000_000 + minor * 1_000 + patch;
    requireValue(minor < 1000 && patch < 1000 && Number.isSafeInteger(build),
      "Invalid Baha Plus version components");
    version = match.slice(1).join(".");
    buildVersion = String(build);
  }
  return {
    bundleIdentifier: [...bundles][0],
    version,
    buildVersion,
    minOSVersion: [...minimums][0],
    ...(release.assets[0].digest
      ? { sha256: release.assets[0].digest.slice("sha256:".length) } : {}),
  };
}

async function assetKey(spec: AppSpec, release: Release): Promise<string> {
  const asset = release.assets[0];
  const text = JSON.stringify([
    spec.repo, spec.versionStrategy, spec.iosProjectPath, release.tag_name,
    asset.id, asset.updated_at, asset.size, asset.digest ?? null, asset.browser_download_url,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildFeed(
  github: GitHub,
  cached: MetadataCache,
  previous?: Feed,
): Promise<BuildResult> {
  requireValue(config.apps.length === ALLOWED_REPOS.length
    && new Set(config.apps.map((spec) => spec.repo)).size === ALLOWED_REPOS.length,
  "Feed must contain exactly the allowlisted repositories");
  const nextMetadata: MetadataCache = {};
  const apps: FeedApp[] = [];
  for (const spec of config.apps) {
    assertSpec(spec);
    const releases = await github.releases(spec);
    const versions: AppVersion[] = [];
    const seen = new Set<string>();
    let bundle: string | undefined;
    for (const release of releases) {
      const key = await assetKey(spec, release);
      const metadata = cached[key] ?? await metadataFor(spec, release, github);
      nextMetadata[key] = metadata;
      bundle ??= metadata.bundleIdentifier;
      requireValue(metadata.bundleIdentifier === bundle, "Bundle identifier changed across releases");
      const identity = `${metadata.version}:${metadata.buildVersion}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      versions.push({
        version: metadata.version,
        buildVersion: metadata.buildVersion,
        minOSVersion: metadata.minOSVersion,
        ...(metadata.sha256 ? { sha256: metadata.sha256 } : {}),
        date: release.published_at,
        localizedDescription: release.body?.trim() || "上游未提供更新说明。",
        downloadURL: release.assets[0].browser_download_url,
        size: release.assets[0].size,
        releaseTag: release.tag_name,
        source: release.html_url,
        metadataSource: "github-release-and-tag-source",
      });
      if (versions.length === config.versionsToKeep) break;
    }
    requireValue(bundle && versions.length, "No valid application versions");
    const website = `https://github.com/${spec.repo}`;
    const old = previous?.apps.find((app) => app.website === website);
    requireValue(!old || old.bundleIdentifier === bundle,
      "Bundle identifier changed since the previous feed");
    const latest = versions[0];
    apps.push({
      name: spec.name,
      developerName: spec.developerName,
      subtitle: spec.subtitle,
      localizedDescription: spec.localizedDescription,
      tintColor: spec.tintColor,
      category: spec.category,
      bundleIdentifier: bundle,
      website,
      iconURL: `https://raw.githubusercontent.com/${spec.repo}/${
        encodeURIComponent(latest.releaseTag)}/${spec.iconPath.split("/").map(encodeURIComponent).join("/")}`,
      versions,
      version: latest.version,
      versionDate: latest.date,
      versionDescription: latest.localizedDescription,
      downloadURL: latest.downloadURL,
      size: latest.size,
      minOSVersion: latest.minOSVersion,
    });
  }
  requireValue(new Set(apps.map((app) => app.bundleIdentifier)).size === apps.length,
    "Duplicate bundle identifier");
  return {
    feed: {
      ...config.source,
      apps,
      featuredApps: apps.map((app) => app.bundleIdentifier),
      news: [],
    },
    metadata: Object.fromEntries(Object.entries(nextMetadata).slice(-MAX_METADATA_ENTRIES)),
  };
}
