// Dedicated worker that writes recording chunks into OPFS through a
// FileSystemSyncAccessHandle: bytes land in the file in place (no swap file,
// no commit step) and are flushed every few chunks, so a full disk, a crash or
// an update mid-recording keeps everything written so far.
let handle = null;
let pos = 0;
let sinceFlush = 0;

self.onmessage = async ({ data: m }) => {
  const reply = (extra) => self.postMessage({ id: m.id, ok: true, ...extra });
  try {
    if (m.op === "open") {
      const dir = await navigator.storage.getDirectory();
      const fh = await dir.getFileHandle(m.name, { create: true });
      handle = await fh.createSyncAccessHandle();
      pos = handle.getSize();
      reply({ pos });
    } else if (m.op === "write") {
      const bytes = new Uint8Array(m.buf);
      const n = handle.write(bytes, { at: pos });
      pos += n;
      if (n !== bytes.length) throw new Error("QuotaExceededError: the disk is full");
      if (++sinceFlush >= 5) {
        handle.flush();
        sinceFlush = 0;
      }
      reply({ pos });
    } else if (m.op === "close") {
      if (handle) {
        try {
          handle.flush();
        } finally {
          handle.close();
          handle = null;
        }
      }
      reply({ pos });
    }
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: `${(e && e.name) || "Error"}: ${(e && e.message) || e}` });
  }
};
