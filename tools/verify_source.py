"""Validate the subset of AltStore source JSON consumed by Feather."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def https_url(value: object) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlsplit(value)
    return parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username


def validate_source(source: dict, config: dict) -> None:
    for key in ("name", "identifier", "description"):
        require(isinstance(source.get(key), str) and bool(source[key].strip()),
                f"Source: missing {key}")
    require(source["identifier"] == config["source"]["identifier"],
            "Source identifier differs from config")
    for key in ("iconURL", "website"):
        require(https_url(source.get(key)), f"Source: invalid {key}")
    apps = source.get("apps")
    require(isinstance(apps, list) and len(apps) == len(config["apps"]),
            "App count differs from config")
    expected = {f"https://github.com/{app['repo']}" for app in config["apps"]}
    require({app.get("website") for app in apps} == expected,
            "Apps do not match configured repositories")
    identifiers: set[str] = set()
    for app in apps:
        name = app.get("name", "<unnamed>")
        bundle = app.get("bundleIdentifier", "")
        require(isinstance(bundle, str) and bool(re.fullmatch(r"[\w-]+(?:\.[\w-]+)+", bundle)),
                f"{name}: invalid bundle identifier")
        require(bundle not in identifiers, f"{name}: duplicate bundle identifier")
        identifiers.add(bundle)
        require(https_url(app.get("iconURL")), f"{name}: invalid icon URL")
        require(bool(re.fullmatch(r"#[0-9a-fA-F]{6}", app.get("tintColor", ""))),
                f"{name}: invalid tint color")
        for key in ("name", "developerName", "localizedDescription"):
            require(isinstance(app.get(key), str) and bool(app[key].strip()),
                    f"{name}: missing {key}")
        versions = app.get("versions")
        require(isinstance(versions, list) and bool(versions), f"{name}: no versions")
        require(len(versions) <= config["versionsToKeep"], f"{name}: too many versions")
        seen: set[tuple[str, str]] = set()
        dates = []
        for version in versions:
            for key in ("version", "buildVersion"):
                require(isinstance(version.get(key), str) and bool(version[key].strip()),
                        f"{name}: missing {key}")
            identity = (version["version"], version["buildVersion"])
            require(identity not in seen, f"{name}: duplicate version/build")
            seen.add(identity)
            require(https_url(version.get("downloadURL")), f"{name}: invalid download URL")
            download = urlsplit(version["downloadURL"])
            repo = app["website"].removeprefix("https://github.com/")
            require(download.hostname == "github.com"
                    and download.path.startswith(f"/{repo}/releases/download/")
                    and download.path.lower().endswith(".ipa"),
                    f"{name}: download must be an upstream GitHub Release IPA")
            require(type(version.get("size")) is int and version["size"] > 0,
                    f"{name}: invalid IPA size")
            require(bool(re.fullmatch(r"\d+(?:\.\d+){0,2}", version.get("minOSVersion", ""))),
                    f"{name}: invalid minimum iOS version")
            if "sha256" in version:
                require(bool(re.fullmatch(r"[0-9a-f]{64}", version["sha256"])),
                        f"{name}: invalid upstream SHA-256")
            date = datetime.fromisoformat(version["date"].replace("Z", "+00:00"))
            require(date.tzinfo is not None, f"{name}: date must include timezone")
            dates.append(date)
        require(dates == sorted(dates, reverse=True), f"{name}: versions not newest first")
        latest = versions[0]
        for key in ("version", "downloadURL", "size", "minOSVersion"):
            require(app.get(key) == latest[key], f"{name}: inconsistent legacy {key}")
        require(app.get("versionDate") == latest["date"], f"{name}: inconsistent legacy date")
        require(app.get("versionDescription") == latest["localizedDescription"],
                f"{name}: inconsistent legacy release notes")
    require(set(source.get("featuredApps", [])) <= identifiers,
            "Featured apps contain an unknown bundle identifier")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "apps.json")
    parser.add_argument("--config", type=Path, default=ROOT / "source.config.json")
    args = parser.parse_args()
    try:
        source = json.loads(args.source.read_text(encoding="utf-8"))
        config = json.loads(args.config.read_text(encoding="utf-8"))
        validate_source(source, config)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"Invalid source: {error}\n")
    print(f"Valid Feather source: {len(source['apps'])} apps")
    for app in source["apps"]:
        print(f"  {app['name']}: {app['version']} "
              f"({app['versions'][0]['buildVersion']}), "
              f"iOS {app['minOSVersion']}+, {len(app['versions'])} versions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
