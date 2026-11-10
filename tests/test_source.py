from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.build_source import (
    GitHub,
    SafeRedirect,
    cache_key,
    generate,
    main,
    source_metadata,
    stable_releases,
)
from tools.verify_source import validate_source

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "source.config.json").read_text(encoding="utf-8"))


def release(spec: dict, tag: str, version: str, build: str, day: int, identity: int) -> dict:
    filename = (f"PiliPlus_ios_{version}+{build}.ipa"
                if spec["versionStrategy"] == "pili-asset" else "BahaPlus-iOS-unsigned.ipa")
    return {
        "tag_name": tag,
        "published_at": f"2026-11-{day:02d}T08:00:00Z",
        "html_url": f"https://github.com/{spec['repo']}/releases/tag/{tag}",
        "body": f"{version} release notes",
        "draft": False,
        "prerelease": False,
        "assets": [{
            "id": identity,
            "name": filename,
            "size": 1000,
            "digest": "sha256:" + "a" * 64,
            "updated_at": f"2026-11-{day:02d}T08:01:00Z",
            "browser_download_url": f"https://github.com/{spec['repo']}/releases/download/{tag}/{filename}",
        }],
    }


class FakeGitHub:
    def __init__(self):
        pili, baha = CONFIG["apps"]
        self.data = {
            pili["repo"]: [
                release(pili, "2.2.0.1", "2.2.0", "5590", 2, 2),
                release(pili, "2.2.0.2", "2.2.0", "5598", 3, 3),
                release(pili, "2.2.0", "2.2.0", "5580", 1, 1),
            ],
            baha["repo"]: [
                release(baha, "v0.5.1", "0.5.1", "5001", 10, 13),
                release(baha, "v0.5.0", "0.5.0", "5000", 9, 12),
                release(baha, "v0.4.0", "0.4.0", "4000", 7, 11),
            ],
        }
        self.failed = set()
        self.text_calls = 0

    def releases(self, repo):
        if repo in self.failed:
            raise OSError("simulated outage")
        return copy.deepcopy(self.data[repo])

    def text(self, repo, path, tag):
        self.text_calls += 1
        if path.endswith(".pbxproj"):
            bundle = "com.example.piliplus" if "PiliPlus" in repo else "app.bahaplus.mobile"
            return (
                f"PRODUCT_BUNDLE_IDENTIFIER = {bundle};\n"
                f"PRODUCT_BUNDLE_IDENTIFIER = {bundle}.RunnerTests;\n"
                "IPHONEOS_DEPLOYMENT_TARGET = 15.0;\n"
            )
        if path.endswith("release_version.py"):
            return "build_number = major * 1_000_000 + minor * 1_000 + patch"
        if path.endswith("release.yml"):
            return 'flutter build ios --build-name "$RELEASE_VERSION" --build-number "$BUILD_NUMBER"'
        raise AssertionError(f"Unexpected source request: {path}")


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.config = copy.deepcopy(CONFIG)
        self.github = FakeGitHub()

    def source(self):
        return generate(self.config, {}, {}, self.github)[0]

    def test_uses_asset_version_instead_of_pili_tag(self):
        source = self.source()
        self.assertEqual(source["apps"][0]["version"], "2.2.0")
        self.assertEqual(source["apps"][0]["versions"][0]["buildVersion"], "5598")
        self.assertEqual(source["apps"][0]["versions"][0]["releaseTag"], "2.2.0.2")

    def test_baha_build_number_matches_upstream_formula(self):
        app = self.source()["apps"][1]
        self.assertEqual((app["version"], app["versions"][0]["buildVersion"]), ("0.5.1", "5001"))
        self.assertEqual(app["bundleIdentifier"], "app.bahaplus.mobile")

    def test_stable_releases_are_sorted_and_prereleases_excluded(self):
        spec = self.config["apps"][0]
        data = self.github.data[spec["repo"]]
        draft = copy.deepcopy(data[0])
        draft["draft"] = True
        beta = copy.deepcopy(data[0])
        beta["tag_name"] = "v3.0.0-beta1"
        flagged = copy.deepcopy(data[0])
        flagged["prerelease"] = True
        selected = stable_releases(data + [draft, beta, flagged], spec["assetPattern"])
        self.assertEqual([item[0]["tag_name"] for item in selected], ["2.2.0.2", "2.2.0.1", "2.2.0"])

    def test_ambiguous_ipa_assets_are_rejected(self):
        spec = self.config["apps"][0]
        data = self.github.releases(spec["repo"])
        data[0]["assets"].append(copy.deepcopy(data[0]["assets"][0]))
        with self.assertRaisesRegex(ValueError, "Ambiguous IPA"):
            stable_releases(data, spec["assetPattern"])

    def test_metadata_cache_avoids_repeated_source_requests(self):
        cache = {}
        first, _ = generate(self.config, {}, cache, self.github)
        calls = self.github.text_calls
        second, _ = generate(self.config, first, cache, self.github)
        self.assertEqual(first, second)
        self.assertEqual(self.github.text_calls, calls)

    def test_asset_replacement_invalidates_cache(self):
        spec = self.config["apps"][0]
        item = self.github.data[spec["repo"]][0]
        asset = item["assets"][0]
        key = cache_key(spec, item, asset)
        asset["updated_at"] = "2026-11-10T00:00:00Z"
        self.assertNotEqual(key, cache_key(spec, item, asset))

    def test_keeps_previous_app_on_upstream_failure(self):
        previous = self.source()
        self.github.failed.add(self.config["apps"][0]["repo"])
        result, warnings = generate(self.config, previous, {}, self.github)
        self.assertEqual(result["apps"][0], previous["apps"][0])
        self.assertEqual(len(result["apps"]), 2)
        self.assertEqual(len(warnings), 1)

    def test_initial_failure_does_not_produce_partial_feed(self):
        self.github.failed.add(self.config["apps"][1]["repo"])
        with self.assertRaisesRegex(ValueError, "initial build failed"):
            generate(self.config, {}, {}, self.github)

    def test_changed_bundle_identifier_keeps_previous_entry(self):
        previous = self.source()
        original = self.github.text

        def changed(repo, path, tag):
            text = original(repo, path, tag)
            if "PiliPlus" in repo and tag == "2.2.0.1":
                return text.replace("com.example.piliplus", "com.changed.piliplus")
            return text

        with patch.object(self.github, "text", side_effect=changed):
            result, warnings = generate(self.config, previous, {}, self.github)
        self.assertEqual(result["apps"][0], previous["apps"][0])
        self.assertIn("bundle identifier changed", warnings[0])

    def test_changed_upstream_formula_is_rejected(self):
        spec = self.config["apps"][1]
        item = self.github.data[spec["repo"]][0]
        original = self.github.text

        def changed(repo, path, tag):
            return "build_number = 1" if path.endswith(".py") else original(repo, path, tag)

        with patch.object(self.github, "text", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "formula changed"):
                source_metadata(spec, item, item["assets"][0], self.github)

    def test_release_asset_is_never_opened(self):
        github = GitHub()
        with patch.object(github, "opener") as opener:
            with self.assertRaisesRegex(ValueError, "IPA downloads are disabled"):
                github.open("https://github.com/owner/repo/releases/download/v1/app.ipa")
            opener.open.assert_not_called()

    def test_unsafe_api_redirect_is_rejected(self):
        from urllib.request import Request
        request = Request("https://api.github.com/test",
                          headers={"Authorization": "Bearer fake-test-token"})
        with self.assertRaisesRegex(ValueError, "authenticated"):
            SafeRedirect().redirect_request(
                request, None, 302, "redirect", {}, "https://example.com/"
            )

    def test_unknown_client_version_strategy_is_rejected(self):
        spec = self.config["apps"][0]
        spec["versionStrategy"] = "unknown"
        item = self.github.data[spec["repo"]][0]
        with self.assertRaisesRegex(ValueError, "Unknown version strategy"):
            source_metadata(spec, item, item["assets"][0], self.github)

    def test_verifier_rejects_missing_app_and_inconsistent_legacy_fields(self):
        source = self.source()
        source["apps"][0]["version"] = "wrong"
        with self.assertRaisesRegex(ValueError, "inconsistent legacy"):
            validate_source(source, self.config)
        source = self.source()
        source["apps"].pop()
        with self.assertRaisesRegex(ValueError, "App count"):
            validate_source(source, self.config)

    def test_verifier_rejects_duplicate_versions_and_other_download_hosts(self):
        source = self.source()
        source["apps"][0]["versions"][1] = copy.deepcopy(source["apps"][0]["versions"][0])
        with self.assertRaisesRegex(ValueError, "duplicate version"):
            validate_source(source, self.config)
        source = self.source()
        source["apps"][0]["versions"][0]["downloadURL"] = "https://example.com/app.ipa"
        with self.assertRaisesRegex(ValueError, "upstream GitHub"):
            validate_source(source, self.config)

    def test_strict_failure_leaves_feed_unchanged(self):
        previous = self.source()
        self.github.failed.add(self.config["apps"][0]["repo"])
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "apps.json"
            cache = Path(temporary) / "cache.json"
            output.write_text(json.dumps(previous), encoding="utf-8")
            original = output.read_bytes()
            args = ["build_source.py", "--strict", "--output", str(output), "--cache", str(cache)]
            with patch("sys.argv", args), patch("tools.build_source.GitHub", return_value=self.github):
                self.assertEqual(main(), 1)
            self.assertEqual(output.read_bytes(), original)
            self.assertFalse(cache.exists())


if __name__ == "__main__":
    unittest.main()
