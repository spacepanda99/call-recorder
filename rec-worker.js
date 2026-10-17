// Writes recordings straight to the browser's private disk (OPFS) as WAV, in place,
// so a crash or closed tab loses at most the last second. Runs in a worker because
// sync access handles are only allowed there.
"use strict";
const RATE = 48000;
let h = null, name = "", dataBytes = 0, writes = 0;
let queue = Promise.resolve();
let flushed = true, flushResolve = null;

function writeData(buf) {
  if (!h) return;
  const u8 = new Uint8Array(buf);
  h.write(u8, { at: 44 + dataBytes }); dataBytes += u8.byteLength;
  if (++writes % 5 === 0) { h.write(header(dataBytes), { at: 0 }); h.flush(); }
}
// Audio arrives here straight from the AudioWorklet (a MessagePort), not through the page,
// so recording keeps going even when the page's main thread is slowed down with the screen off.
function onPort(e) {
  const m = e.data;
  if (m.op === "write") writeData(m.buf);
  else if (m.op === "flushed") { flushed = true; if (flushResolve) { flushResolve(); flushResolve = null; } }
}

function header(bytes) {
  const v = new DataView(new ArrayBuffer(44));
  const s = (o, t) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  s(0, "RIFF"); v.setUint32(4, 36 + bytes, true); s(8, "WAVE");
  s(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  s(36, "data"); v.setUint32(40, bytes, true);
  return new Uint8Array(v.buffer);
}
async function folder() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("recordings", { create: true });
}
async function openHandle(file, create) {
  const fh = await (await folder()).getFileHandle(file, { create });
  return fh.createSyncAccessHandle();
}
// Multiply every sample by gain, in 1 MB blocks (used by "auto-level").
function applyGain(handle, bytes, gain) {
  const block = new Int16Array(1 << 19);
  for (let at = 44; at < 44 + bytes; at += block.byteLength) {
    const n = handle.read(block, { at });
    const view = n === block.byteLength ? block : new Int16Array(block.buffer, 0, n >> 1);
    for (let i = 0; i < view.length; i++) {
      const x = Math.round(view[i] * gain);
      view[i] = x > 32767 ? 32767 : x < -32768 ? -32768 : x;
    }
    handle.write(view, { at });
  }
}

async function handle(m) {
  if (m.op === "probe") {
    const ok = typeof FileSystemFileHandle !== "undefined" && "createSyncAccessHandle" in FileSystemFileHandle.prototype && !!(navigator.storage && navigator.storage.getDirectory);
    return { op: "probe", ok };
  }
  if (m.op === "open") {
    h = await openHandle(m.name, true);
    h.truncate(0); h.write(header(0), { at: 0 }); h.flush();
    name = m.name; dataBytes = 0; writes = 0; flushed = !m.direct;
    return { op: "opened", name };
  }
  if (m.op === "write") { writeData(m.buf); return null; }
  if (m.op === "close") {
    if (!h) return { op: "closed", name, bytes: 0 };
    if (!flushed) await Promise.race([new Promise((r) => (flushResolve = r)), new Promise((r) => setTimeout(r, 3000))]);
    if (m.gain && m.gain > 1.01) applyGain(h, dataBytes, m.gain);
    h.write(header(dataBytes), { at: 0 }); h.flush(); h.close(); h = null;
    return { op: "closed", name, bytes: dataBytes, gain: m.gain || 1 };
  }
  if (m.op === "repair") {           // fix the header of a file cut off by a crash
    const r = await openHandle(m.name, false);
    let bytes = Math.max(0, r.getSize() - 44); bytes -= bytes % 2;
    r.truncate(44 + bytes); r.write(header(bytes), { at: 0 }); r.flush(); r.close();
    return { op: "repaired", name: m.name, bytes };
  }
  if (m.op === "delete") {
    await (await folder()).removeEntry(m.name).catch(() => {});
    return { op: "deleted", name: m.name };
  }
  return null;
}

onmessage = (e) => {
  const m = e.data;
  if (m.op === "port") { m.port.onmessage = onPort; return; }
  queue = queue.then(() => handle(m)).then((r) => { if (r) postMessage({ ...r, id: m.id }); })
    .catch((err) => postMessage({ op: "error", id: m.id, error: String(err && err.message || err) }));
};
