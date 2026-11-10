"""Build a Feather source from public Release metadata and text source files."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urlsplit

try:
    from .verify_source import https_url, require, validate_source
except ImportError:
    from verify_source import https_url, require, validate_source

ROOT = Path(__file__).resolve().parents[1]
MAX_JSON_BYTES = 8 * 1024 * 1024


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        require(urlsplit(new_url).scheme == "https", "Refusing non-HTTPS redirect")
        require(not request.has_header("Authorization"),
                "Refusing redirect of an authenticated API request")
        return super().redirect_request(request, fp, code, message, headers, new_url)


class GitHub:
    def __init__(self) -> None:
        self.token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
        self.opener = urllib.request.build_opener(SafeRedirect())

    def open(self, url: str):
        require(https_url(url), "Only HTTPS resources are supported")
        require(urlsplit(url).hostname == "api.github.com",
                "Only GitHub JSON API requests are supported; IPA downloads are disabled")
        headers = {"User-Agent": "InternetBugs-Feather-Source", "Accept-Encoding": "identity"}
        headers["Accept"] = "application/vnd.github+json"
        headers["X-GitHub-Api-Version"] = "2022-11-28"
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return self.opener.open(urllib.request.Request(url, headers=headers), timeout=90)

    def api(self, path: str):
        with self.open(f"https://api.github.com/{path}") as response:
            raw = response.read(MAX_JSON_BYTES + 1)
        require(len(raw) <= MAX_JSON_BYTES, "GitHub JSON response too large")
        return json.loads(raw)

    def releases(self, repo: str, pages: int = 3) -> list[dict]:
        result = []
        for page in range(1, pages + 1):
            batch = self.api(f"repos/{repo}/releases?per_page=30&page={page}")
            require(isinstance(batch, list), f"{repo}: invalid release response")
            result.extend(batch)
            if len(batch) < 30:
                break
        return result

    def text(self, repo: str, path: str, tag: str) -> str:
        require(path.endswith((".pbxproj", ".py", ".yml", ".yaml", ".ps1")),
                "Only supported text source files may be fetched")
        data = self.api(f"repos/{repo}/contents/{quote(path, safe='/')}?ref={quote(tag, safe='')}")
        require(data.get("type") == "file" and data.get("encoding") == "base64",
                f"{repo}: source file is unavailable: {path}")
        return base64.b64decode(data["content"]).decode("utf-8")


def source_metadata(spec: dict, release: dict, asset: dict, github: GitHub) -> dict:
    tag, repo = release["tag_name"], spec["repo"]
    project = github.text(repo, spec["iosProjectPath"], tag)
    bundles = set(re.findall(r'PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([\w.-]+)"?\s*;', project))
    bundles = {bundle for bundle in bundles if not bundle.endswith((".RunnerTests", ".Tests"))}
    require(len(bundles) == 1, f"{repo}: ambiguous application bundle identifier in Xcode project")
    minimums = set(re.findall(r'IPHONEOS_DEPLOYMENT_TARGET\s*=\s*"?(\d+(?:\.\d+){0,2})"?\s*;',
                              project))
    require(len(minimums) == 1, f"{repo}: ambiguous minimum iOS version in Xcode project")
    strategy = spec["versionStrategy"]
    if strategy == "pili-asset":
        match = re.fullmatch(r"PiliPlus_ios_(\d+\.\d+\.\d+)\+(\d+)\.ipa", asset["name"])
        require(match is not None, f"{repo}: unrecognized IPA filename version")
        version, build = match.groups()
    elif strategy == "baha-tag":
        match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", tag)
        require(match is not None, f"{repo}: unrecognized release tag")
        script = github.text(repo, "tools/release_version.py", tag)
        require(bool(re.search(
            r"build_number\s*=\s*major\s*\*\s*1_000_000\s*\+\s*minor\s*\*\s*1_000\s*\+\s*patch",
            script)), f"{repo}: upstream build-number formula changed")
        workflow = github.text(repo, ".github/workflows/release.yml", tag)
        require('--build-name "$RELEASE_VERSION" --build-number "$BUILD_NUMBER"' in workflow,
                f"{repo}: upstream version build arguments changed")
        major, minor, patch = map(int, match.groups())
        require(minor < 1000 and patch < 1000, f"{repo}: invalid release version components")
        version = ".".join(match.groups())
        build = str(major * 1_000_000 + minor * 1_000 + patch)
    else:
        raise ValueError(f"Unknown version strategy: {strategy}")
    metadata = {
        "bundleIdentifier": next(iter(bundles)),
        "version": version,
        "buildVersion": build,
        "minOSVersion": next(iter(minimums)),
    }
    declared = asset.get("digest")
    if declared:
        require(bool(re.fullmatch(r"sha256:[0-9a-f]{64}", declared)), "Invalid GitHub asset digest")
        metadata["sha256"] = declared.removeprefix("sha256:")
    return metadata


def read_json(path: Path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8", newline="\n")
    temporary.replace(path)


def cache_key(spec: dict, release: dict, asset: dict) -> str:
    identity = [spec["repo"], spec["versionStrategy"], spec["iosProjectPath"],
                release["tag_name"], asset["id"], asset["updated_at"], asset["size"],
                asset.get("digest"), asset["browser_download_url"]]
    return hashlib.sha256(json.dumps(identity, separators=(",", ":")).encode()).hexdigest()


def stable_releases(releases: list[dict], pattern: str) -> list[tuple[dict, dict]]:
    selected = []
    for release in releases:
        if release.get("draft") or release.get("prerelease") or not release.get("published_at"):
            continue
        if re.search(r"(?:^|[-_.])(alpha|beta|rc|nightly|dev|preview)(?:\d|[-_.]|$)",
                     release["tag_name"], re.IGNORECASE):
            continue
        assets = [asset for asset in release.get("assets", [])
                  if asset.get("state", "uploaded") == "uploaded"
                  and re.fullmatch(pattern, asset["name"], re.IGNORECASE)]
        require(len(assets) <= 1, f"Ambiguous IPA assets in {release['tag_name']}")
        if assets:
            selected.append((release, assets[0]))
    selected.sort(key=lambda pair: datetime.fromisoformat(
        pair[0]["published_at"].replace("Z", "+00:00")), reverse=True)
    return selected


def build_app(spec: dict, count: int, github: GitHub, cache: dict,
              reprobe: bool = False) -> dict:
    releases = stable_releases(github.releases(spec["repo"]), spec["assetPattern"])
    require(bool(releases), f"{spec['repo']}: no stable release with matching IPA")
    versions = []
    bundle = None
    seen = set()
    latest_tag = None
    for release, asset in releases:
        repo_path = f"/{spec['repo']}/releases/download/"
        parsed = urlsplit(asset["browser_download_url"])
        require(parsed.scheme == "https" and parsed.hostname == "github.com"
                and parsed.path.startswith(repo_path), "IPA is not hosted by the upstream project")
        key = cache_key(spec, release, asset)
        metadata = cache.get(key) if not reprobe else None
        if metadata is None:
            print(f"Reading Release/source metadata: {spec['name']} {release['tag_name']}")
            metadata = source_metadata(spec, release, asset, github)
            cache[key] = metadata
        if bundle is None:
            bundle = metadata["bundleIdentifier"]
        require(metadata["bundleIdentifier"] == bundle,
                f"{spec['name']}: bundle identifier changed across releases")
        identity = (metadata["version"], metadata["buildVersion"])
        if identity in seen:
            continue
        seen.add(identity)
        latest_tag = latest_tag or release["tag_name"]
        versions.append({
            "version": metadata["version"],
            "buildVersion": metadata["buildVersion"],
            "date": release["published_at"],
            "localizedDescription": (release.get("body") or "").strip() or "上游未提供更新说明。",
            "downloadURL": asset["browser_download_url"],
            "size": asset["size"],
            "minOSVersion": metadata["minOSVersion"],
            "releaseTag": release["tag_name"],
            "source": release["html_url"],
            "metadataSource": "github-release-and-tag-source",
        })
        if metadata.get("sha256"):
            versions[-1]["sha256"] = metadata["sha256"]
        if len(versions) == count:
            break
    latest = versions[0]
    app = {key: spec[key] for key in (
        "name", "developerName", "subtitle", "localizedDescription", "tintColor", "category"
    )}
    app.update({
        "bundleIdentifier": bundle,
        "website": f"https://github.com/{spec['repo']}",
        "iconURL": (f"https://raw.githubusercontent.com/{spec['repo']}/"
                    f"{quote(latest_tag, safe='')}/{quote(spec['iconPath'], safe='/')}"),
        "versions": versions,
        "version": latest["version"],
        "versionDate": latest["date"],
        "versionDescription": latest["localizedDescription"],
        "downloadURL": latest["downloadURL"],
        "size": latest["size"],
        "minOSVersion": latest["minOSVersion"],
    })
    return app


def generate(config: dict, previous: dict, cache: dict, github: GitHub,
             reprobe: bool = False) -> tuple[dict, list[str]]:
    count = config["versionsToKeep"]
    require(type(count) is int and 1 <= count <= 10, "versionsToKeep must be between 1 and 10")
    require(bool(config["apps"]), "At least one app must be configured")
    repos = [spec["repo"] for spec in config["apps"]]
    require(len(repos) == len(set(repos)), "Duplicate app repository in config")
    old_apps = {app.get("website"): app for app in previous.get("apps", [])}
    apps, warnings = [], []
    for spec in config["apps"]:
        try:
            app = build_app(spec, count, github, cache, reprobe)
        except (OSError, ValueError, KeyError, TypeError) as error:
            old = old_apps.get(f"https://github.com/{spec['repo']}")
            if old is None:
                raise ValueError(f"{spec['name']}: initial build failed: {error}") from error
            app = old
            warnings.append(f"{spec['name']}: {error}; kept previous entry")
        apps.append(app)
    source = {**config["source"], "apps": apps,
              "featuredApps": [app["bundleIdentifier"] for app in apps], "news": []}
    validate_source(source, config)
    return source, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "source.config.json")
    parser.add_argument("--output", type=Path, default=ROOT / "apps.json")
    parser.add_argument("--cache", type=Path, default=ROOT / "cache" / "release-metadata.json")
    parser.add_argument("--refresh", action="store_true", help="Read text metadata again, ignoring cache")
    parser.add_argument("--strict", action="store_true", help="Fail if any previous entry was reused")
    args = parser.parse_args()
    try:
        config = read_json(args.config, None)
        require(isinstance(config, dict), "Missing source configuration")
        previous = read_json(args.output, {})
        cache = read_json(args.cache, {})
        source, warnings = generate(config, previous, cache, GitHub(), args.refresh)
        for warning in warnings:
            print(f"WARNING {warning}", file=sys.stderr)
        require(not (args.strict and warnings), "Strict mode: upstream refresh failed")
        # Write only after the entire feed passes validation.
        write_json(args.output, source)
        write_json(args.cache, cache)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Build failed: {error}", file=sys.stderr)
        return 1
    print(f"Generated {args.output.name}: {len(source['apps'])} apps")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
