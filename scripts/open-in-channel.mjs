// Opens a URL in the Chrome profile of the channel/business Google account, never the default
// profile. Use it for every sign-in, OAuth consent (wrangler/gh/gcloud login) and dashboard link.
//
//   npm run open -- <url>
//   npm run open -- --which          prints the profile directory it would use
//
// The profile is found by its primary account (Chrome "Local State" → profile.info_cache.user_name);
// if several profiles use it, the most recently active wins. Override: CHANNEL_PROFILE="Profile 4".
// Nothing else from Chrome's files is read or printed.
import { readFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

export const CHANNEL_EMAIL = "arcan2252@gmail.com";
const USER_DATA = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
const CHROME_PATHS = [
  path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
];

class OpenError extends Error {}
const fail = (m) => {
  throw new OpenError(m);
};

export async function channelProfile() {
  if (process.env.CHANNEL_PROFILE) return process.env.CHANNEL_PROFILE;
  let cache;
  try {
    cache = JSON.parse(await readFile(path.join(USER_DATA, "Local State"), "utf8")).profile.info_cache;
  } catch {
    fail(`can't read Chrome's profile list (${USER_DATA}\\Local State) — is Chrome installed for this user?`);
  }
  const hits = Object.entries(cache)
    .filter(([, info]) => (info.user_name || "").toLowerCase() === CHANNEL_EMAIL)
    .sort(([, a], [, b]) => (b.active_time || 0) - (a.active_time || 0));
  if (!hits.length) fail(`no Chrome profile is signed in as ${CHANNEL_EMAIL} — sign that account into its own Chrome profile, or set CHANNEL_PROFILE`);
  return hits[0][0];
}

async function chromeExe() {
  for (const p of CHROME_PATHS) {
    try {
      await access(p);
      return p;
    } catch {
      /* next */
    }
  }
  return fail("chrome.exe not found");
}

async function main() {
  const arg = process.argv[2];
  const profile = await channelProfile();
  if (arg === "--which") return console.log(profile);
  if (!arg || !/^https?:\/\//.test(arg)) fail("usage: npm run open -- <http(s) url>");
  const child = spawn(await chromeExe(), [`--profile-directory=${profile}`, arg], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  console.log(`opened in Chrome profile "${profile}" (${CHANNEL_EMAIL})`);
}

main().catch((e) => {
  console.error(e instanceof OpenError ? `open: ${e.message}` : e);
  process.exit(1);
});
