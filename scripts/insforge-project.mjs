import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Shared by the local setup scripts (edge functions can't share modules, these can).
// `npx @insforge/cli create` / `link` write .insforge/project.json with the backend URL
// (oss_host) and the project's server API key (api_key), so the scripts can fill in
// what a first-time user would otherwise have to copy by hand.

export function readLinkedProject() {
  const file = path.resolve(".insforge/project.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// Explicit value first, then INSFORGE_BASE_URL, then the linked project.
export function resolveBaseUrl(explicit) {
  return normalizeBaseUrl(explicit || process.env.INSFORGE_BASE_URL || readLinkedProject()?.oss_host || "");
}

export function insforge(args, { silent = false } = {}) {
  return (
    execFileSync("npx", ["@insforge/cli", ...args], {
      encoding: "utf8",
      stdio: silent ? ["ignore", "pipe", "pipe"] : "inherit"
    }) || ""
  );
}

// Returns "" when the secret doesn't exist or the CLI isn't linked/logged in.
export function readSecret(key) {
  try {
    return JSON.parse(insforge(["secrets", "get", key, "--json"], { silent: true })).value || "";
  } catch {
    return "";
  }
}

// booleanFlags never consume the next argument, so `--force /Volumes/Kindle` keeps the path.
export function parseArgs(argv, booleanFlags = []) {
  const flags = new Set();
  const values = new Map();
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
    } else if (booleanFlags.includes(arg)) {
      flags.add(arg);
    } else if (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
      values.set(arg, argv[++index]);
    } else {
      flags.add(arg);
    }
  }
  return { flags, values, positional };
}
