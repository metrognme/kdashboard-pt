import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const force = process.argv.includes("--force");
const volumeArg = process.argv.slice(2).find((arg) => arg !== "--force");
const dataUrl = process.env.DASHBOARD_DATA_URL || "";
const eventsUrl = process.env.DASHBOARD_EVENTS_URL || "";
const toggleUrl = process.env.DASHBOARD_TOGGLE_URL || "";
const readToken = process.env.DASHBOARD_READ_TOKEN || "";
const toggleToken = process.env.DASHBOARD_TOGGLE_TOKEN || "";
const title = process.env.DASHBOARD_TITLE || "Kindle Dashboard";
const archive = path.resolve("kindle/native/build/kindle-dashboard-kual.tar.gz");
const volume = path.resolve(volumeArg || "/Volumes/Kindle");
const extensionsDir = path.join(volume, "extensions");
const documentsDir = path.join(volume, "documents");
const targetDir = path.join(extensionsDir, "kindle-dashboard");
const targetConfig = path.join(targetDir, "config.sh");
const launchScript = path.join(documentsDir, "kindle-dashboard-launch.sh");
const cacheFile = path.join(documentsDir, "kindle-dashboard-data.json");
const existingConfig = existsSync(targetConfig) ? readFileSync(targetConfig, "utf8") : "";

if (!existsSync(archive)) {
  console.error(`Missing package: ${archive}`);
  console.error("Build it with: make -C kindle/native extension-zig ZIG=/path/to/zig");
  process.exit(1);
}

if (!existsSync(volume)) {
  console.error(`Kindle volume not found: ${volume}`);
  process.exit(1);
}

if (!force && !isLikelyKindleVolume(volume)) {
  console.error(`Refusing to install: ${volume} does not look like a mounted Kindle volume.`);
  console.error("Expected a Kindle-like volume name or an existing documents/ directory.");
  console.error("Rerun with --force only after manually confirming the target path.");
  process.exit(1);
}

mkdirSync(extensionsDir, { recursive: true });
mkdirSync(documentsDir, { recursive: true });
rmSync(targetDir, { recursive: true, force: true });
execFileSync("tar", ["-C", extensionsDir, "-xzf", archive], {
  env: { ...process.env, COPYFILE_DISABLE: "1" },
  stdio: "inherit"
});
execFileSync("find", [targetDir, "-name", "._*", "-delete"], { stdio: "inherit" });
copyFileSync(path.resolve("kindle/launch-dashboard.sh"), launchScript);
execFileSync("chmod", ["+x", launchScript], { stdio: "inherit" });
rmSync(path.join(documentsDir, "._kindle-dashboard-launch.sh"), { force: true });
// Forced-light/forced-dark copies of the upstart launcher used to be written here too
// (kindle-dashboard-launch-light.sh / -dark.sh), but nothing ever pointed at them: upstart
// always execs the plain launcher above, and the KUAL menu's own Light/Dark entries run
// extensions/kindle-dashboard/bin/start-light.sh / start-dark.sh instead, a different pair of
// files entirely. They were dead weight on the device from the first install. Clean one up
// with:
//   rm -f /mnt/us/documents/kindle-dashboard-launch-light.sh /mnt/us/documents/kindle-dashboard-launch-dark.sh
// DARK_MODE in config.sh already controls the plain launcher's theme, so there is nothing to
// replace them with.

if (existingConfig) {
  writeFileSync(targetConfig, existingConfig);
  console.log(`Preserved existing dashboard config at ${targetConfig}`);
} else if (dataUrl || eventsUrl || toggleUrl) {
  writeFileSync(
    targetConfig,
    [
      `DASHBOARD_DATA_URL="${shellDoubleQuote(dataUrl)}"`,
      `DASHBOARD_EVENTS_URL="${shellDoubleQuote(eventsUrl)}"`,
      `DASHBOARD_TOGGLE_URL="${shellDoubleQuote(toggleUrl)}"`,
      `DASHBOARD_READ_TOKEN="${shellDoubleQuote(readToken)}"`,
      `DASHBOARD_TOGGLE_TOKEN="${shellDoubleQuote(toggleToken)}"`,
      `DASHBOARD_TITLE="${shellDoubleQuote(title)}"`,
      "",
      'INTERVAL="300"',
      'DASHBOARD_KEEP_AWAKE="1"',
      'DASHBOARD_SLEEP_WINDOW="off"',
      'DARK_MODE="0"',
      ""
    ].join("\n")
  );
  console.log(`Created dashboard config at ${targetConfig}`);
}

if (dataUrl) {
  try {
    const response = await fetch(dataUrl, {
      headers: readToken ? { "X-Dashboard-Read-Token": readToken } : undefined
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.text();
    JSON.parse(payload);
    writeFileSync(cacheFile, payload);
    rmSync(path.join(documentsDir, "._kindle-dashboard-data.json"), { force: true });
    console.log(`Seeded dashboard cache at ${cacheFile}`);
  } catch (error) {
    console.warn(`Could not seed dashboard cache: ${error.message}`);
  }
} else {
  console.warn("Skipping cache seed because DASHBOARD_DATA_URL is not set.");
}

writeFileSync(
  path.join(volume, "KINDLE_DASHBOARD_NATIVE_INSTALLED.txt"),
  [
    "Kindle native dashboard installed.",
    "",
    "Extension path:",
    "  /mnt/us/extensions/kindle-dashboard",
    "",
    "Manual/upstart launcher:",
    "  /mnt/us/documents/kindle-dashboard-launch.sh",
    "  (theme follows DARK_MODE in config.sh; the KUAL menu below overrides it per launch)",
    "",
    "KUAL menu:",
    "  Kindle Dashboard -> Start Dashboard (Light)",
    "  Kindle Dashboard -> Start Dashboard (Dark)",
    "  Kindle Dashboard -> Refresh Once (Light)",
    "  Kindle Dashboard -> Refresh Once (Dark)",
    "  Kindle Dashboard -> Stop Dashboard",
    "",
    "Menu ping log on device:",
    "  /mnt/us/documents/kindle-dashboard-menu-ping.log",
    "",
    "Proof render artifacts:",
    "  /mnt/us/documents/kindle-dashboard-proof.log",
    "  /mnt/us/documents/kindle-dashboard-last-render.pgm",
    "",
    "Diagnostic log on device:",
    "  /mnt/us/documents/kindle-dashboard-diagnose.log",
    "",
    "Seeded/offline data cache:",
    "  /mnt/us/documents/kindle-dashboard-data.json",
    "",
    "Data endpoint:",
    dataUrl ? `  ${dataUrl}` : "  not seeded; set DASHBOARD_DATA_URL before install to seed the cache",
    ""
  ].join("\n")
);

execFileSync("sync", [], { stdio: "inherit" });
console.log(`Installed Kindle Dashboard extension to ${targetDir}`);

function isLikelyKindleVolume(volumePath) {
  const name = path.basename(volumePath).toLowerCase();
  return name.includes("kindle") || existsSync(path.join(volumePath, "documents"));
}

function shellDoubleQuote(value) {
  return String(value).replace(/["\\$`]/g, "\\$&");
}
