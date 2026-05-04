import { readFileSync, writeFileSync } from "fs";

// `npm version <X.Y.Z>` writes the new version into package.json and sets
// $npm_package_version before invoking the "version" script. We mirror that
// version into manifest.json and append it to versions.json so Obsidian and
// BRAT can pick up the release. The Obsidian release flow requires the git
// tag to exactly match this version (no "v" prefix).

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  console.error("version-bump.mjs: npm_package_version is not set. Run via `npm version <X.Y.Z>`.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const minAppVersion = manifest.minAppVersion;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`Bumped manifest.json and versions.json to ${targetVersion} (minAppVersion ${minAppVersion}).`);
