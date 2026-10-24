// Share to Google Drive (Pro). Only the drive.file scope: the extension can see
// and change only the files it created itself, nothing else in the user's Drive.
// Flow: find-or-create a folder named after the brand → resumable upload in chunks → make the
// file readable by anyone with the link → return webViewLink.
// `fetch` and `getToken` are injected so this runs (and is tested) anywhere.

import { BRAND } from "../../../../brand.config.js";

export const DRIVE = "https://www.googleapis.com";
export const FOLDER_NAME = BRAND;
const CHUNK = 8 * 1024 * 1024; // multiple of 256 KiB, as the resumable protocol requires

export class DriveError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // "offline" | "auth" | "quota" | "server"
  }
}

/**
 * @param {object} o
 * @param {(interactive:boolean)=>Promise<string>} o.getToken
 * @param {(token:string)=>Promise<void>} o.dropToken  forget a token Google rejected
 * @param {typeof fetch} o.fetch
 * @param {{get:()=>Promise<string|null>, set:(id:string)=>Promise<void>}} o.folderCache
 */
export function createDrive({ getToken, dropToken, fetch: f, folderCache, base = DRIVE }) {
  let token = null;

  async function call(url, init = {}, { retryAuth = true } = {}) {
    if (!token) token = await getToken(true);
    let res;
    try {
      res = await f(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
    } catch {
      throw new DriveError("offline", "You're offline. Try Share again when you're back online.");
    }
    if (res.status === 401 && retryAuth) {
      // Revoked or expired: forget it and ask again once.
      await dropToken(token);
      token = await getToken(true);
      return call(url, init, { retryAuth: false });
    }
    if (res.status === 401) throw new DriveError("auth", "Google said no. Press Share again and click Allow.");
    if (res.status === 403) {
      const reason = await errorReason(res);
      if (/storageQuotaExceeded|quotaExceeded/.test(reason)) throw new DriveError("quota", "Your Google Drive is full. Free some space and press Share again.");
      if (/rateLimitExceeded|userRateLimitExceeded|sharingRateLimitExceeded/.test(reason)) throw new DriveError("busy", "Google Drive is busy. Wait a minute and press Share again.");
      throw new DriveError("forbidden", "Google Drive refused this. Your account may not allow uploads from apps.");
    }
    return res;
  }

  async function errorReason(res) {
    try {
      const j = await res.clone().json();
      return ((j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || (j.error && j.error.status) || "") + "";
    } catch {
      return "";
    }
  }

  async function json(res) {
    if (!res.ok) throw new DriveError("server", `Google Drive answered ${res.status}. Try again in a minute.`);
    return res.json();
  }

  async function folderId() {
    const cached = await folderCache.get();
    if (cached) {
      const res = await call(`${base}/drive/v3/files/${encodeURIComponent(cached)}?fields=id,trashed`);
      if (res.ok) {
        const j = await res.json();
        if (!j.trashed) return cached;
      }
    }
    // drive.file only lists folders this extension created, so this never finds a user's own folder of that name.
    const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const found = await json(await call(`${base}/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`));
    let id = found.files && found.files[0] && found.files[0].id;
    if (!id) {
      const made = await json(
        await call(`${base}/drive/v3/files?fields=id`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
        }),
      );
      id = made.id;
    }
    await folderCache.set(id);
    return id;
  }

  /**
   * @param {Blob} file
   * @param {string} name
   * @param {(fraction:number)=>void} onProgress
   * @returns {Promise<{id:string, link:string}>}
   */
  async function share(file, name, onProgress = () => {}) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw new DriveError("offline", "You're offline. Try Share again when you're back online.");
    const parent = await folderId();
    const start = await call(`${base}/upload/drive/v3/files?uploadType=resumable&fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": file.type || "application/octet-stream", "X-Upload-Content-Length": String(file.size) },
      body: JSON.stringify({ name, parents: [parent], mimeType: file.type || "application/octet-stream" }),
    });
    if (!start.ok) await json(start);
    const session = start.headers.get("Location");
    if (!session) throw new DriveError("server", "Google Drive did not start the upload. Try again.");

    let sent = 0;
    let result = null;
    let failures = 0;
    while (sent < file.size || (file.size === 0 && !result)) {
      const end = Math.min(file.size, sent + CHUNK);
      let res;
      try {
        res = await f(session, { method: "PUT", headers: { "Content-Range": file.size ? `bytes ${sent}-${end - 1}/${file.size}` : "bytes */0" }, body: file.slice(sent, end) });
      } catch {
        // Network dropped mid-upload: ask the session where it got to, a few times, then give up cleanly.
        if (++failures > 3) throw new DriveError("offline", "The connection dropped. Try Share again when you're back online.");
        sent = await resumeOffset(session, file.size, sent);
        continue;
      }
      if (res.status === 308) {
        // Range says what Drive has. No Range means it has nothing yet: start over, and count it.
        const range = res.headers.get("Range");
        const got = range ? Number(range.split("-")[1]) + 1 : 0;
        if (!range || got <= sent) {
          if (++failures > 3) throw new DriveError("server", "Google Drive didn't take the upload. Try again in a minute.");
        } else failures = 0;
        sent = got;
        onProgress(sent / file.size);
        continue;
      }
      if (res.status >= 500 && ++failures <= 3) {
        sent = await resumeOffset(session, file.size, sent);
        continue;
      }
      result = await json(res);
      sent = file.size;
      onProgress(1);
    }
    if (!result || !result.id) throw new DriveError("server", "Google Drive did not finish the upload. Try again.");
    // Anyone with the link may watch. Some work and school accounts forbid that: then the
    // file stays private (it is already uploaded) and we say so instead of uploading again.
    let isPrivate = false;
    try {
      await json(
        await call(`${base}/drive/v3/files/${encodeURIComponent(result.id)}/permissions?fields=id`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "reader", type: "anyone" }),
        }),
      );
    } catch (e) {
      if (e.kind === "offline") throw e;
      isPrivate = true;
    }
    const meta = await json(await call(`${base}/drive/v3/files/${encodeURIComponent(result.id)}?fields=webViewLink`));
    return { id: result.id, link: meta.webViewLink, private: isPrivate };
  }

  async function resumeOffset(session, total, fallback) {
    try {
      const res = await f(session, { method: "PUT", headers: { "Content-Range": `bytes */${total}` } });
      if (res.status === 308) {
        const range = res.headers.get("Range");
        return range ? Number(range.split("-")[1]) + 1 : 0;
      }
    } catch {
      /* still offline */
    }
    return fallback;
  }

  return { share, folderId };
}
