// Engine version. Rules files declare a minEngineVersion; a rules file that
// needs a newer engine than this one is rejected and the last good rules stay.
export const ENGINE_VERSION = "1.0.0";

const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

/** Parse "MAJOR.MINOR.PATCH" into three integers, or null if malformed. */
export function parseVersion(v) {
  if (typeof v !== "string") return null;
  const m = SEMVER.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1. Throws on a malformed version so callers can never compare garbage. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new TypeError(`Invalid version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** True only when candidate is a valid version strictly newer than current. */
export function isNewer(candidate, current) {
  if (!parseVersion(candidate)) return false;
  if (!parseVersion(current)) return true;
  return compareVersions(candidate, current) > 0;
}
