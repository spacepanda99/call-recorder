"use strict";
const VERSION = "1.8.0";
// If the page and this script come from different releases (a phone cached one of them),
// reload once to pull matching files.
(() => {
  const pageV = (document.querySelector('meta[name="app-version"]') || {}).content;
  try {
    if (pageV && pageV !== VERSION && sessionStorage.getItem("gablab-reloaded") !== VERSION) {
      sessionStorage.setItem("gablab-reloaded", VERSION); location.reload(); return;
    }
  } catch (e) {}
})();
// GabLab: a live WebRTC call between two phones, while each phone records its own raw mic
// to a 48 kHz / 16-bit mono WAV on its own disk. See README.md.

const PREFIX = "boomirec-v1-";            // peer ids on the free PeerJS server: PREFIX + room code
const RATE = 48000;
const ICE = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
// Relay (TURN) credentials come from our Cloudflare Worker (turn-worker/). When a direct
// phone-to-phone link is blocked (common on mobile data), the call goes through the relay.
const TURN_URL = "https://callrec-turn.michaelgodekirk.workers.dev/ice";
const WIN = 2400;                          // 50 ms analysis window
const TARGET_PEAK_DB = -4;                 // where loud words should land
const DISTANCES = [8, 10, 12, 15, 20, 25, 30, 40, 45];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dbOf = (x) => (x > 0 ? 20 * Math.log10(x) : -120);
const pct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
const p2 = (n) => String(n).padStart(2, "0");
const hms = (s) => { s = Math.floor(s); return p2(Math.floor(s / 3600)) + ":" + p2(Math.floor(s / 60) % 60) + ":" + p2(s % 60); };
const ms = (s) => { s = Math.floor(s); return Math.floor(s / 60) + ":" + p2(s % 60); };
const mb = (b) => (b / 1e6).toFixed(1) + " MB";     // decimal MB/GB, same as Android's storage screen
const gb = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b < 1e7 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e6) + " MB");
const BYTES_PER_HOUR = 48000 * 2 * 3600;                // 48 kHz x 16-bit mono = 345.6 MB per hour
const hm = (bytes) => { const m = Math.floor(bytes / (BYTES_PER_HOUR / 60)); return m >= 60 ? Math.floor(m / 60) + " h " + (m % 60) + " min" : m + " min"; };
const cmText = (cm) => cm + " cm (" + Math.round(cm / 2.54) + " in)";
const show = (id, on) => $(id).classList.toggle("hidden", !on);
function log(m) { const el = $("log"); el.textContent = new Date().toLocaleTimeString() + "  " + m + "\n" + el.textContent; }
function setStatus(m) { $("status").textContent = m; }
function banner(m) { $("globalBanner").innerHTML = m; show("globalBanner", !!m); }

// ---------- settings + history (localStorage) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("callrec." + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("callrec." + k, JSON.stringify(v)); } catch (e) {} },
};
const S = Object.assign({ name: "", tpl: "{date}_{time}_{me}_with_{friend}", afterSave: "download", autoLevel: true, keepAwake: true, speakerOff: false, forceRelay: false, micId: "", distance: 20 }, store.get("settings", {}));
const saveSettings = () => store.set("settings", S);
let history = store.get("history", []);
const saveHistory = () => store.set("history", history);
const memBlobs = {};                       // fallback storage when the browser has no OPFS

// ---------- disk writer (worker + OPFS) ----------
let worker = null, opfs = false, wid = 0;
const wwait = {};
function wcall(msg) {
  return new Promise((res, rej) => { const id = ++wid; wwait[id] = { res, rej }; worker.postMessage({ ...msg, id }); });
}
async function initWorker() {
  try {
    worker = new Worker("rec-worker.js?v=" + VERSION);
    worker.onmessage = (e) => {
      const d = e.data, w = wwait[d.id];
      if (!w) { if (d.op === "error") log("Disk error: " + d.error); return; }
      delete wwait[d.id];
      if (d.op === "error") w.rej(new Error(d.error)); else w.res(d);
    };
    opfs = (await Promise.race([wcall({ op: "probe" }), new Promise((r) => setTimeout(() => r({ ok: false }), 3000))])).ok;
  } catch (e) { opfs = false; }
  log(opfs ? "Recordings are written straight to this phone's storage" : "This browser can't write to disk directly; recordings are kept in memory until saved");
}
async function recordingsDir() { return (await navigator.storage.getDirectory()).getDirectoryHandle("recordings", { create: true }); }
async function getEntryFile(e) {
  let blob;
  if (e.store === "memory") blob = memBlobs[e.file];
  else blob = await (await (await recordingsDir()).getFileHandle(e.file)).getFile();
  if (!blob) throw new Error("File is no longer stored");
  return new File([blob], e.exportName || e.file, { type: "audio/wav" });
}

// ---------- names ----------
function clean(s) { return String(s || "").trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-").slice(0, 32); }
function buildName(e, tpl) {
  const d = new Date(e.date);
  const map = {
    date: d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()),
    time: p2(d.getHours()) + "-" + p2(d.getMinutes()) + "-" + p2(d.getSeconds()),
    me: clean(e.me) || "me", friend: clean(e.friend) || (e.role === "solo" ? "solo" : "friend"),
    room: e.room || "solo", role: e.role || "",
  };
  let n = (tpl || S.tpl || "{date}_{time}").replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m));
  if (e.role === "solo") n = n.replace(/[_-]?with[_-]solo/g, "_solo");
  n = n.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-").replace(/[_-]{3,}/g, "_").replace(/^[_-]+|[_-]+$/g, "");
  return (n || "recording") + (e.status === "recovered" ? "_recovered" : "") + ".wav";
}

// ---------- folder export (desktop Chrome / any browser with showDirectoryPicker) ----------
const canPickFolder = "showDirectoryPicker" in window;
let folderHandle = null;
function kv(mode, fn) {
  return new Promise((res, rej) => {
    const r = indexedDB.open("callrec-kv", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onerror = () => rej(r.error);
    r.onsuccess = () => { const tx = r.result.transaction("kv", mode); const q = fn(tx.objectStore("kv")); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); };
  });
}
async function loadFolder() {
  if (!canPickFolder) return;
  try { folderHandle = await kv("readonly", (s) => s.get("folder")) || null; } catch (e) {}
  $("folderInfo").textContent = folderHandle ? "Folder: " + folderHandle.name : "No folder chosen.";
}
async function pickFolder() {
  try {
    folderHandle = await window.showDirectoryPicker({ id: "callrec", mode: "readwrite", startIn: "music" });
    await kv("readwrite", (s) => s.put(folderHandle, "folder"));
    $("folderInfo").textContent = "Folder: " + folderHandle.name;
    return true;
  } catch (e) { return false; }
}
async function saveToFolder(e) {
  if (!folderHandle && !(await pickFolder())) throw new Error("No folder chosen");
  let perm = await folderHandle.queryPermission({ mode: "readwrite" });
  if (perm !== "granted") perm = await folderHandle.requestPermission({ mode: "readwrite" });
  if (perm !== "granted") throw new Error("No permission for that folder");
  const fh = await folderHandle.getFileHandle(e.exportName, { create: true });
  const w = await fh.createWritable();
  await (await getEntryFile(e)).stream().pipeTo(w);
  log("Saved to folder " + folderHandle.name + ": " + e.exportName);
}
async function downloadEntry(e) {
  const f = await getEntryFile(e);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(f); a.download = e.exportName; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  log("Downloaded " + e.exportName);
}
async function shareEntry(e) {
  const f = await getEntryFile(e);
  if (!navigator.canShare || !navigator.canShare({ files: [f] })) throw new Error("Sharing files isn't supported here");
  await navigator.share({ files: [f], title: e.exportName });
}
async function exportEntry(e, how) {
  try {
    if (how === "folder" && canPickFolder) await saveToFolder(e);
    else if (how === "share") await shareEntry(e);
    else if (how === "download" || how === "folder") await downloadEntry(e);
  } catch (err) {
    log("Couldn't " + how + ": " + err.message + ". Use the buttons to save it.");
  }
}

// ---------- history UI ----------
async function renderHistory() {
  const list = $("histList");
  history = history.filter((e) => e.store !== "memory" || memBlobs[e.file]);
  if (!history.length) { list.textContent = "No recordings yet."; }
  else {
    list.innerHTML = history.map((e, i) => {
      const when = new Date(e.date).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const bits = [when, e.status === "recording" ? "recording now" : hms(e.secs || 0).replace(/^00:/, ""), e.bytes ? gb(e.bytes) : "",
        e.friend ? "with " + esc(e.friend) : ""].filter(Boolean);
      const extra = [e.peakDb != null ? "peak " + e.peakDb.toFixed(1) + " dB" : "", e.gainDb > 0.1 ? "raised +" + e.gainDb.toFixed(1) + " dB" : "",
        (e.markers || []).length ? "marks " + e.markers.map(ms).join(", ") : ""].filter(Boolean);
      return '<div class="hist" data-i="' + i + '"><div class="name">' + esc(e.exportName || e.file) +
        (e.status === "recovered" ? ' <span class="pill">recovered</span>' : "") + "</div>" +
        '<div class="meta">' + bits.join(" · ") + "</div>" +
        (extra.length ? '<div class="meta">' + extra.join(" · ") + "</div>" : "") +
        (e.status === "recording" ? "" :
          '<div class="acts"><button data-a="play">▶ Play</button><button data-a="download">Download</button>' +
          (navigator.canShare ? '<button data-a="share">Share</button>' : "") +
          (canPickFolder ? '<button data-a="folder">To folder</button>' : "") +
          '<button data-a="rename">Rename</button><button class="del" data-a="delete">Delete</button></div>') +
        "</div>";
    }).join("");
  }
  renderStorage();
}

// ---------- disk space ----------
// navigator.storage.estimate() gives the space Chrome lets this page use. That follows the phone's
// free space but isn't exactly the same number, so everything here says "about".
async function freeSpace() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const est = await navigator.storage.estimate();
    return { free: Math.max(0, (est.quota || 0) - (est.usage || 0)), usage: est.usage || 0 };
  } catch (e) { return null; }
}
async function renderStorage() {
  const sp = await freeSpace();
  const used = history.reduce((n, e) => n + (e.bytes || 0), 0);
  $("storageInfo").textContent = history.length ? gb(used) + " in this app" : "";
  if (!sp) { $("spaceCard").innerHTML = '<div class="space-note">Free space unknown in this browser. Recording uses 346 MB per hour.</div>'; return; }
  const low = sp.free < 2 * BYTES_PER_HOUR;
  $("spaceCard").innerHTML = '<div class="space-text"><div><b>' + hm(sp.free) + "</b> of recording space left</div>" +
    '<div class="muted">' + gb(sp.free) + " available to GabLab</div></div>" +
    '<div class="space-note">' + (history.length ? gb(used) + " in " + history.length + " recording" + (history.length === 1 ? "" : "s") + " · " : "") +
    "346 MB per hour" + (low ? ' · <span style="color:var(--warn)">Low on space. Free some up before a long call.</span>' : "") +
    "<br>After uploading, you can delete your files here to free up space.</div>";
}
let spaceLeft = null;
async function spaceTick() {
  if (!recording) { $("spaceInfo").textContent = ""; return; }
  const sp = await freeSpace();
  if (!sp) return;
  spaceLeft = sp.free;
  const el = $("spaceInfo");
  el.textContent = "Space left: about " + hm(sp.free) + " (" + gb(sp.free) + ")";
  el.style.color = sp.free < BYTES_PER_HOUR / 6 ? "var(--red)" : "";
  if (sp.free < 25e6) {                                 // under ~4 min: stop cleanly instead of failing mid-write
    banner("Recording stopped because the phone is almost out of space. The file was saved.");
    log("Stopping: storage almost full");
    stopRecording(false);
  } else if (sp.free < BYTES_PER_HOUR / 6) {
    banner("Phone storage is almost full: about " + hm(sp.free) + " of recording left.");
  }
}
setInterval(spaceTick, 15000);
$("histList").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-a]"); if (!b) return;
  const row = b.closest(".hist"), e = history[+row.dataset.i]; if (!e) return;
  const a = b.dataset.a;
  if (a === "play") {
    let au = row.querySelector("audio");
    if (!au) { au = document.createElement("audio"); au.controls = true; au.src = URL.createObjectURL(await getEntryFile(e)); row.appendChild(au); }
    au.play();
  } else if (a === "rename") {
    const n = prompt("New file name", e.exportName.replace(/\.wav$/, ""));
    if (n && clean(n)) { e.exportName = n.replace(/[\\/:*?"<>|]+/g, "").trim() + ".wav"; saveHistory(); renderHistory(); }
  } else if (a === "delete") {
    if (!confirm("Delete " + e.exportName + " from this app? Copies you downloaded or shared are not affected.")) return;
    if (e.store === "memory") delete memBlobs[e.file]; else await wcall({ op: "delete", name: e.file }).catch(() => {});
    history.splice(+row.dataset.i, 1); saveHistory(); renderHistory();
  } else {
    await exportEntry(e, a);
  }
});

// ---------- microphone + AudioWorklet ----------
const WORKLET = `
// Runs on the audio thread. Sends raw blocks to the page for the meter, and while recording it
// converts to 16-bit and sends 1-second chunks straight to the disk worker through "out".
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.out = null; this.rec = false; this.buf = new Int16Array(48000); this.n = 0; this.frames = 0; this.peak = 0; this.lastStat = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.port) this.out = m.port;
      if (m.cmd === "start") { this.rec = true; this.n = 0; this.frames = 0; this.peak = 0; this.lastStat = 0; }
      if (m.cmd === "stop") {
        if (this.rec) { this.rec = false; this.flush(); }
        if (this.out) this.out.postMessage({ op: "flushed" });
        this.port.postMessage({ stat: true, frames: this.frames, peak: this.peak, final: true });
      }
    };
  }
  flush() {
    if (this.n && this.out) { const b = this.buf.slice(0, this.n).buffer; this.out.postMessage({ op: "write", buf: b }, [b]); }
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    this.port.postMessage(ch.slice(0));
    if (this.rec) {
      for (let i = 0; i < ch.length; i++) {
        let v = ch[i]; const a = v < 0 ? -v : v; if (a > this.peak) this.peak = a;
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.buf.length) this.flush();
      }
      this.frames += ch.length;
      if (this.frames - this.lastStat >= 4800) { this.lastStat = this.frames; this.port.postMessage({ stat: true, frames: this.frames, peak: this.peak }); }
    }
    return true;
  }
}
registerProcessor("tap", Tap);`;
let tap = null, direct = false, finalStat = null;
let ctx = null, micStream = null, sendStream = null, micInfo = { label: "", rate: 0, bt: false };

async function ensureMic() {
  if (micStream && micStream.active && ctx && ctx.state !== "closed") { if (ctx.state !== "running") await ctx.resume(); return; }
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, sampleRate: RATE };
  if (S.micId) audio.deviceId = { exact: S.micId };
  try { micStream = await navigator.mediaDevices.getUserMedia({ audio, video: false }); }
  catch (e) {
    if (!S.micId) throw e;
    delete audio.deviceId; log("Chosen mic not found, using the default");
    micStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  }
  const t = micStream.getAudioTracks()[0], s = t.getSettings();
  micInfo = { label: t.label || "default mic", rate: s.sampleRate || 0, bt: /bluetooth|hands-?free|headset|airpods|buds|\bbt\b|sco/i.test(t.label || "") };
  log("Mic: " + micInfo.label + " | rate " + (s.sampleRate || "?") + " | echoCancel " + s.echoCancellation + " | noiseSup " + s.noiseSuppression + " | AGC " + s.autoGainControl);
  $("micLabel").textContent = "(" + micInfo.label.slice(0, 30) + ")";
  ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
  if (ctx.sampleRate !== RATE) throw new Error("This browser would not run audio at 48 kHz (got " + ctx.sampleRate + ").");
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
  const src = ctx.createMediaStreamSource(micStream);
  tap = new AudioWorkletNode(ctx, "tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit" });
  const silent = ctx.createGain(); silent.gain.value = 0;     // keeps the node running without playing the mic back
  src.connect(tap).connect(silent).connect(ctx.destination);
  tap.port.onmessage = (e) => {
    const d = e.data;
    if (!d.stat) { onAudio(d); return; }
    if (direct) { recFrames = d.frames; recPeak = d.peak; }
    if (d.final && finalStat) { finalStat(d); finalStat = null; }
  };
  if (opfs) {                                                  // wire the worklet straight to the disk worker
    const ch = new MessageChannel();
    worker.postMessage({ op: "port", port: ch.port1 }, [ch.port1]);
    tap.port.postMessage({ port: ch.port2 }, [ch.port2]);
  }
  if (ctx.state !== "running") await ctx.resume();
  sendStream = new MediaStream([t.clone()]);                  // separate copy for the call, so "mute" doesn't mute the recording
  sendStream.getAudioTracks()[0].enabled = !muted;
  log("Audio engine at " + ctx.sampleRate + " Hz");
  listMics();
  if (micInfo.bt) banner("A Bluetooth mic is in use (" + esc(micInfo.label) + "). Bluetooth call mics are low quality. Use wired earphones, or pick the phone's own mic under More › Microphone &amp; distance.");
}
function releaseMic() {
  if (recording || inCall) return;
  try { micStream && micStream.getTracks().forEach((t) => t.stop()); sendStream && sendStream.getTracks().forEach((t) => t.stop()); ctx && ctx.close(); } catch (e) {}
  micStream = null; sendStream = null; ctx = null;
}
async function listMics() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId);
    $("micSelect").innerHTML = '<option value="">Phone default</option>' + devs.map((d, i) => '<option value="' + esc(d.deviceId) + '">' + esc(d.label || "Mic " + (i + 1)) + "</option>").join("");
    $("micSelect").value = devs.some((d) => d.deviceId === S.micId) ? S.micId : "";
  } catch (e) {}
}

// ---------- audio analysis ----------
let peakHold = 0, clipUntil = 0, winSum = 0, winPeak = 0, winN = 0;
const wins = [];                           // last 15 s of 50 ms windows {p, r}
let checkSink = null;                      // mic check collects windows here
let recording = false, recEntry = null, recFrames = 0, recPeak = 0;
let pending = new Int16Array(RATE), pendingLen = 0, memChunks = [];

function onAudio(f32) {
  let peak = 0;
  for (let i = 0; i < f32.length; i++) {
    const x = f32[i], v = x < 0 ? -x : x;
    if (v > peak) peak = v;
    winSum += x * x; if (v > winPeak) winPeak = v;
    if (++winN === WIN) {
      const w = { p: winPeak, r: Math.sqrt(winSum / WIN) };
      wins.push(w); if (wins.length > 300) wins.shift();
      if (checkSink) checkSink.push(w);
      winSum = 0; winPeak = 0; winN = 0;
    }
  }
  if (peak >= 0.99) clipUntil = performance.now() + 1500;
  peakHold = Math.max(peak, peakHold * 0.92);
  if (!recording || direct) return;
  if (peak > recPeak) recPeak = peak;
  for (let i = 0; i < f32.length; i++) {
    const v = f32[i] > 1 ? 1 : f32[i] < -1 ? -1 : f32[i];
    pending[pendingLen++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    if (pendingLen === RATE) flushChunk();
  }
  recFrames += f32.length;
}
function flushChunk() {
  if (!pendingLen) return;
  const buf = pending.slice(0, pendingLen).buffer;
  pendingLen = 0;
  if (opfs) worker.postMessage({ op: "write", buf }, [buf]);
  else memChunks.push(new Blob([buf]));
}

// Distance needed to move loud words to TARGET_PEAK_DB (level falls ~6 dB each time distance doubles).
function distanceFor(loudDb, fromCm) {
  const raw = fromCm / Math.pow(10, (TARGET_PEAK_DB - loudDb) / 20);
  const near = DISTANCES.reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));
  return { cm: near, tooFar: raw < 8, tooNear: raw > 45 };
}
function analyse(list) {
  if (list.length < 20) return null;
  const rs = list.map((w) => w.r).sort((a, b) => a - b);
  const noise = rs[Math.floor(rs.length * 0.1)];
  const thr = Math.max(noise * 4, Math.pow(10, -50 / 20));   // 12 dB above the floor counts as talking
  const speech = list.filter((w) => w.r > thr);
  const ps = speech.map((w) => w.p).sort((a, b) => a - b);
  const loud = ps.length ? ps[Math.floor(ps.length * 0.95)] : 0;
  const speechRms = speech.length ? Math.sqrt(speech.reduce((n, w) => n + w.r * w.r, 0) / speech.length) : 0;
  return { noiseDb: dbOf(noise), loudDb: dbOf(loud), speechDb: dbOf(speechRms), snr: dbOf(speechRms) - dbOf(noise), speechSecs: speech.length * 0.05, clips: list.filter((w) => w.p >= 0.99).length };
}
function coachAdvice() {
  const a = analyse(wins);
  if (!a) return { cls: "", text: "Listening…" };
  if (wins.slice(-100).some((w) => w.p >= 0.99)) {
    const d = distanceFor(0, S.distance);
    return { cls: "bad", text: "Too loud: it's clipping. Move the phone back, to about " + cmText(Math.max(d.cm, S.distance + 5)) + ", or speak a little softer." };
  }
  if (a.speechSecs < 1.5) {
    return a.noiseDb > -45 ? { cls: "warn", text: "Background noise is high (" + a.noiseDb.toFixed(0) + " dB). Turn off fans or AC, or find a quieter room." }
      : { cls: "", text: "Waiting for you to talk… Your loud words should reach the green zone." };
  }
  let tip;
  const d = distanceFor(a.loudDb, S.distance);
  if (a.loudDb < -18) tip = { cls: "bad", text: "Too quiet. Bring the phone closer, to about " + cmText(d.cm) + (d.tooFar ? ", and speak up a little" : "") + "." };
  else if (a.loudDb < -9) tip = { cls: "warn", text: "A bit quiet. Move the phone closer, to about " + cmText(d.cm) + "." };
  else if (a.loudDb > -1.5) tip = { cls: "warn", text: "Almost too loud. Move the phone back a little, to about " + cmText(d.cm) + "." };
  else tip = { cls: "good", text: "Good distance. Loud words reach " + a.loudDb.toFixed(0) + " dB." };
  if (a.snr < 25) tip.text += " Background noise is noticeable (" + a.noiseDb.toFixed(0) + " dB); turn off fans or AC if you can.";
  return tip;
}

// ---------- mic check ----------
let checkReturn = "homeView";
function openCheck(from) {
  checkReturn = from;
  show("homeView", false); show("callView", false); show("checkView", true);
  show("checkResult", false); show("checkSentence", false); $("checkStartBtn").disabled = false;
  $("checkStep").textContent = "Put on your earphones and hold the phone the way you will during the call. Tap Start.";
}
async function runCheck() {
  $("checkStartBtn").disabled = true; show("checkResult", false);
  try { await ensureMic(); } catch (e) { $("checkStep").textContent = "Couldn't open the mic: " + e.message; $("checkStartBtn").disabled = false; return; }
  const wait = (t) => new Promise((r) => setTimeout(r, t));
  checkSink = [];
  $("checkStep").innerHTML = "<b>Step 1 of 2:</b> stay quiet for 3 seconds (measuring room noise)…";
  await wait(3000);
  const quiet = checkSink; checkSink = [];
  $("checkStep").innerHTML = "<b>Step 2 of 2:</b> read this out loud at your normal talking volume:";
  show("checkSentence", true);
  await wait(7000);
  const talk = checkSink; checkSink = null;
  show("checkSentence", false);
  const qr = quiet.map((w) => w.r).sort((a, b) => a - b);
  const noiseDb = dbOf(qr[Math.floor(qr.length / 2)] || 0);
  const t = analyse(quiet.concat(talk)) || { loudDb: -120, speechDb: -120, speechSecs: 0, clips: 0 };
  const snr = t.speechDb - noiseDb;
  const rows = [];
  const verdict = (ok, txt) => '<span class="pill ' + (ok === true ? "ok" : ok === false ? "bad" : "") + '">' + txt + "</span>";
  rows.push(["Mic", esc(micInfo.label) + (micInfo.bt ? " " + verdict(false, "Bluetooth: low quality") : "")]);
  rows.push(["Recording format", "48,000 Hz, 16-bit mono WAV" + (micInfo.rate && micInfo.rate < 44100 ? " " + verdict(false, "mic only gives " + micInfo.rate + " Hz") : "")]);
  rows.push(["Room noise", noiseDb.toFixed(0) + " dB " + (noiseDb < -60 ? verdict(true, "very quiet") : noiseDb < -50 ? verdict(true, "quiet") : noiseDb < -40 ? verdict(null, "noticeable") : verdict(false, "noisy"))]);
  let advice, rec = null;
  if (t.speechSecs < 0.5) {
    advice = "We didn't hear you talking. Check nothing covers the bottom of the phone and that Chrome is allowed to use the mic, then try again.";
  } else {
    rows.push(["Your voice (loud words)", t.loudDb.toFixed(1) + " dB " + (t.clips ? verdict(false, "clipping") : t.loudDb > -9 ? verdict(true, "good") : t.loudDb > -18 ? verdict(null, "a bit quiet") : verdict(false, "too quiet"))]);
    rows.push(["Voice vs. noise", snr.toFixed(0) + " dB " + (snr >= 35 ? verdict(true, "excellent") : snr >= 25 ? verdict(true, "OK") : verdict(false, "noisy"))]);
    const d = t.clips ? { cm: Math.min(45, S.distance * 2), tooFar: false } : distanceFor(t.loudDb, S.distance);
    rec = d.cm;
    advice = t.clips ? "Your voice clipped. Hold the phone farther away, about " + cmText(d.cm) + "."
      : Math.abs(d.cm - S.distance) <= 2 ? "Your distance (" + cmText(S.distance) + ") is right. Keep it there."
      : "You're at about " + cmText(S.distance) + ". Best for your voice: about <b>" + cmText(d.cm) + "</b>" + (d.tooFar ? ", and speak up a little" : "") + ".";
    if (snr < 25) advice += " The room is noisy for your voice level: turn off fans or AC, close windows, or move closer to the phone.";
  }
  if (micInfo.bt) advice += " Switch to wired earphones or the phone's own mic. Bluetooth mics record at low quality.";
  $("checkResult").innerHTML = '<table class="result">' + rows.map((r) => "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>").join("") + "</table>" +
    '<div class="coach ' + (rec && Math.abs(rec - S.distance) <= 2 && snr >= 25 ? "good" : "warn") + '">' + advice + "</div>" +
    (rec && rec !== S.distance ? '<button id="useDistBtn">Use ' + cmText(rec) + " from now on</button>" : "") +
    '<div class="muted" style="margin-top:6px">Wrong starting distance? Set it under More › Microphone &amp; distance, then run the check again.</div>';
  show("checkResult", true);
  $("checkStep").textContent = "Done.";
  $("checkStartBtn").textContent = "Run again"; $("checkStartBtn").disabled = false;
  if ($("useDistBtn")) $("useDistBtn").onclick = () => { S.distance = rec; saveSettings(); $("distance").value = String(rec); $("useDistBtn").textContent = "Saved. Hold the phone about " + cmText(rec) + " away."; $("useDistBtn").disabled = true; };
}
$("checkStartBtn").onclick = runCheck;
$("checkDoneBtn").onclick = () => { checkSink = null; show("checkView", false); show(checkReturn, true); if (checkReturn === "homeView") releaseMic(); };

// ---------- recording ----------
async function startRecording() {
  if (recording) return;
  const sp = await freeSpace();
  if (sp && sp.free < 25e6) { banner("Can't record: the phone is almost out of space (" + gb(sp.free) + " free). Delete old recordings or free up space."); log("Not recording: storage full"); return; }
  const file = "rec-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".wav";
  recEntry = { file, date: new Date().toISOString(), role, me: S.name, friend: friend.name, room: roomCode, status: "recording", markers: [], store: opfs ? "opfs" : "memory" };
  recEntry.exportName = buildName(recEntry);
  try { if (opfs) await wcall({ op: "open", name: file, direct: true }); }
  catch (e) { log("Disk write failed (" + e.message + "), keeping this one in memory"); opfs = false; recEntry.store = "memory"; }
  history.unshift(recEntry); saveHistory();
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
  pendingLen = 0; memChunks = []; recFrames = 0; recPeak = 0; recording = true;
  setTimeout(spaceTick, 500);
  direct = recEntry.store === "opfs";
  if (direct) tap.port.postMessage({ cmd: "start" });
  $("recBtn").classList.add("hidden"); show("stopBtn", true); $("markBtn").disabled = false; $("callCheckBtn").disabled = true;
  $("markList").textContent = ""; show("savedCard", false);
  log("Recording started");
}
async function stopRecording(tellFriend) {
  if (!recording) return;
  recording = false;
  if (direct) {
    await Promise.race([new Promise((r) => { finalStat = r; tap.port.postMessage({ cmd: "stop" }); }), new Promise((r) => setTimeout(r, 2000))]);
    direct = false;
  } else flushChunk();
  if (tellFriend) send({ t: "stop" });
  show("stopBtn", false); $("recBtn").classList.remove("hidden"); $("markBtn").disabled = true; $("callCheckBtn").disabled = false;
  $("recState").textContent = "Saving…";
  const e = recEntry; recEntry = null;
  let gain = 1;
  if (S.autoLevel && recPeak > 0.001) gain = Math.min(Math.pow(10, -3 / 20) / recPeak, 10);   // up to +20 dB, never down
  if (gain < 1.01) gain = 1;
  try {
    if (e.store === "opfs") { const r = await wcall({ op: "close", gain }); e.bytes = r.bytes; }
    else {
      const bytes = memChunks.reduce((n, b) => n + b.size, 0);
      memBlobs[e.file] = new Blob([wavHeader(bytes), ...memChunks], { type: "audio/wav" }); memChunks = [];
      e.bytes = bytes; gain = 1;
    }
  } catch (err) { log("Error finishing file: " + err.message); }
  e.secs = (e.bytes || 0) / (RATE * 2);
  e.gainDb = dbOf(gain); e.peakDb = dbOf(recPeak * gain);
  e.friend = e.friend || friend.name; e.status = "done";
  e.exportName = buildName(e);
  saveHistory(); renderHistory();
  window.__lastEntry = e;
  $("recState").textContent = "Saved";
  $("savedInfo").innerHTML = "<b>Saved:</b> " + esc(e.exportName) + '<div class="muted">' + hms(e.secs) + " · " + mb(e.bytes || 0) + " · loudest " + e.peakDb.toFixed(1) + " dB" +
    (e.gainDb > 0.1 ? " (raised +" + e.gainDb.toFixed(1) + " dB)" : "") + "</div>" +
    '<div class="btnrow"><button class="small secondary" id="svDl">Download</button>' + (navigator.canShare ? '<button class="small secondary" id="svSh">Share</button>' : "") +
    (canPickFolder ? '<button class="small secondary" id="svFo">To folder</button>' : "") + "</div>";
  show("savedCard", true);
  $("svDl").onclick = () => exportEntry(e, "download");
  if ($("svSh")) $("svSh").onclick = () => exportEntry(e, "share");
  if ($("svFo")) $("svFo").onclick = () => exportEntry(e, "folder");
  log("Saved " + e.exportName + " (" + hms(e.secs) + ")");
  if (dbOf(recPeak * gain) < -6) log("Note: this recording is quiet. Upload sites often flag files whose loudest peak is under -6 dB.");
  await exportEntry(e, S.afterSave);
}
function wavHeader(bytes) {
  const v = new DataView(new ArrayBuffer(44));
  const s = (o, t) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  s(0, "RIFF"); v.setUint32(4, 36 + bytes, true); s(8, "WAVE"); s(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, "data"); v.setUint32(40, bytes, true);
  return v.buffer;
}
function countdownThen(n, fn) {
  const el = $("countdown");
  if (!n) { fn(); return; }
  el.classList.remove("hidden");
  let k = n;
  const tick = () => { if (k === 0) { el.classList.add("hidden"); fn(); return; } el.textContent = k--; setTimeout(tick, 1000); };
  tick();
}
let countingDown = false;
async function beginRecording(fromFriend, cd) {
  if (recording || countingDown) return;
  if (!fromFriend) {
    const sp = await freeSpace();
    if (sp && sp.free < 25e6) { banner("Can't record: the phone is almost out of space (" + gb(sp.free) + " free)."); return; }
    if (sp && sp.free < BYTES_PER_HOUR / 2 && !confirm("Only about " + hm(sp.free) + " of recording space is left on this phone. Record anyway?")) return;
  }
  countingDown = true;
  if (!fromFriend) send({ t: "rec", cd: 3 });
  countdownThen(cd, () => { countingDown = false; startRecording(); });
}
function addMark(fromFriend) {
  if (!recording || !recEntry) return;
  recEntry.markers.push(+(recFrames / RATE).toFixed(1)); saveHistory();
  if (!fromFriend) send({ t: "mark" });
  $("markList").textContent = "Marks: " + recEntry.markers.map(ms).join(", ");
}

// ---------- recovery after a crash / closed tab ----------
async function recoverInterrupted() {
  const stuck = history.filter((e) => e.status === "recording");
  for (const e of stuck) {
    if (e.store !== "opfs" || !opfs) { history.splice(history.indexOf(e), 1); continue; }
    try {
      const r = await wcall({ op: "repair", name: e.file });
      e.bytes = r.bytes; e.secs = r.bytes / (RATE * 2); e.status = "recovered"; e.exportName = buildName(e);
      banner("Recovered a recording that was cut off: <b>" + esc(e.exportName) + "</b> (" + hms(e.secs) + "). It's in Recordings below.");
    } catch (err) { log("Could not recover " + e.file + ": " + err.message); history.splice(history.indexOf(e), 1); }
  }
  saveHistory();
}

// ---------- the call ----------
let peer = null, call = null, conn = null, role = "", roomCode = "", inCall = false, ending = false, muted = false;
let friend = { name: "", rec: false, secs: 0, db: -120, cls: "", seen: 0 }, everConnected = false, resync = false;
let reconnectTimer = null, reconnectTries = 0;

function send(m) { try { if (conn && conn.open) conn.send(m); } catch (e) {} }
let iceServers = null, relayReady = false;
async function loadIce() {
  if (!TURN_URL) { log("No relay server set up yet: calls must connect directly"); return; }
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(TURN_URL, { signal: ctl.signal, cache: "no-store" }); clearTimeout(t);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    if (!d.iceServers || !d.iceServers.length) throw new Error("no servers");
    iceServers = ICE.concat(d.iceServers); relayReady = true;
    log("Relay server ready (used only if a direct link fails)" + (S.forceRelay ? "; forcing relay for testing" : ""));
  } catch (e) { iceServers = null; relayReady = false; log("Relay server unavailable (" + e.message + "); trying direct only"); }
}
function newPeer(id) {
  return new Promise((res, rej) => {
    const config = { iceServers: iceServers || ICE };
    if (S.forceRelay && relayReady) config.iceTransportPolicy = "relay";
    const p = new Peer(id, { config, debug: 1 });
    let opened = false;
    p.on("open", () => { opened = true; res(p); });
    p.on("error", (e) => {
      if (!opened) { rej(e); return; }
      log("Connection note: " + e.type);
      if (e.type === "peer-unavailable" && !everConnected) setStatus("No call with code " + roomCode + ". Check the code, and that your friend's phone is still on the call screen.");
    });
    p.on("disconnected", () => { if (!ending) { log("Lost the signaling server, reconnecting…"); try { p.reconnect(); } catch (e) {} } });
  });
}
function dial() {
  wireConn(peer.connect(PREFIX + roomCode, { reliable: true }));
  wireCall(peer.call(PREFIX + roomCode, sendStream));
}
function connected() {
  everConnected = true; reconnectTries = 0;
  if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; resync = true; log("Reconnected"); }
  setStatus("Connected. You can talk.");
  $("recBtn").disabled = false;
}
function wireCall(c) {
  call = c;
  c.on("stream", (s) => { if (call !== c) return; $("remoteAudio").srcObject = s; $("remoteAudio").play().catch(() => {}); connected(); log("Audio connected"); });
  c.on("close", () => { if (call === c) { call = null; lost(); } });
  c.on("error", (e) => log("Call error: " + e));
  const pc = c.peerConnection;
  if (pc) pc.addEventListener("iceconnectionstatechange", () => {
    if (call !== c) return;
    log("Link: " + pc.iceConnectionState);
    if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") lost();
    if (pc.iceConnectionState === "failed" && !relayReady) log("Direct link failed and no relay server is available");
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") connected();
  });
}
function wireConn(c) {
  conn = c;
  c.on("data", (m) => {
    if (conn !== c || !m) return;
    if (m.t === "hb") onHeartbeat(m);
    else if (m.t === "rec") beginRecording(true, m.cd || 0);
    else if (m.t === "stop") stopRecording(false);
    else if (m.t === "mark") addMark(true);
    else if (m.t === "bye") { stopRecording(false); friend.name && log(friend.name + " hung up"); setStatus("Your friend hung up." + (role === "host" ? " Waiting in case they rejoin…" : "")); $("recBtn").disabled = true; friend.seen = 0; }
  });
  c.on("close", () => { if (conn === c) { conn = null; lost(); } });
}
function lost() {
  if (ending || !inCall) return;
  setStatus(recording ? "Connection lost. Your recording is still going. Reconnecting…" : "Connection lost. Reconnecting…");
  if (role !== "guest" || reconnectTimer) return;
  reconnectTimer = setInterval(() => {
    const pc = call && call.peerConnection;
    if (pc && conn && conn.open && /connected|completed/.test(pc.iceConnectionState)) { connected(); return; }
    if (++reconnectTries > 60) { clearInterval(reconnectTimer); reconnectTimer = null; setStatus("Couldn't reconnect. Recording continues; tap Hang up to save, then start a new call."); return; }
    const oc = call, ocn = conn; call = null; conn = null;
    try { oc && oc.close(); } catch (e) {} try { ocn && ocn.close(); } catch (e) {}
    if (peer && !peer.destroyed) { if (peer.disconnected) try { peer.reconnect(); } catch (e) {} dial(); }
  }, 5000);
}
function onHeartbeat(m) {
  friend.name = clean(m.name) ? String(m.name).slice(0, 24) : friend.name; friend.rec = !!m.rec; friend.secs = m.secs || 0; friend.db = m.db; friend.cls = m.cls || ""; friend.tip = m.tip || ""; friend.space = m.space;
  friend.seen = Date.now();
  if (recEntry && !recEntry.friend && friend.name) { recEntry.friend = friend.name; saveHistory(); }
  if (resync) { resync = false; if (recording && !friend.rec) { log("Friend's phone wasn't recording after the reconnect; starting it"); send({ t: "rec", cd: 0 }); } }
}
async function sendHeartbeat() {
  if (!conn || !conn.open) return;
  const last = wins.slice(-20).reduce((n, w) => Math.max(n, w.p), 0);
  send({ t: "hb", name: S.name, rec: recording, secs: recFrames / RATE, db: +dbOf(last).toFixed(0), cls: lastTip.cls, tip: lastTip.text, space: spaceLeft });
}
async function updateQuality() {
  const pc = call && call.peerConnection;
  if (!pc || !/connected|completed/.test(pc.iceConnectionState)) { $("quality").textContent = ""; return; }
  try {
    const st = await pc.getStats();
    let rtt = null, lost = 0, recv = 0, type = "";
    const byId = {};
    st.forEach((r) => { byId[r.id] = r; });
    st.forEach((r) => {
      if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") { rtt = r.currentRoundTripTime; const lc = byId[r.localCandidateId]; type = lc ? lc.candidateType : ""; }
      if (r.type === "inbound-rtp" && r.kind === "audio") { lost = r.packetsLost || 0; recv = r.packetsReceived || 0; }
    });
    const loss = recv ? (100 * lost) / (lost + recv) : 0;
    const q = (rtt != null && rtt > 0.4) || loss > 5 ? "poor" : (rtt != null && rtt > 0.2) || loss > 1 ? "OK" : "good";
    $("quality").textContent = "Call quality " + q + (rtt != null ? " · " + Math.round(rtt * 1000) + " ms delay" : "") + " · " + loss.toFixed(1) + "% lost" +
      (type === "relay" ? " · via relay" : type ? " · direct" : "") + ". This only affects the live call, not your recording.";
  } catch (e) {}
}

async function enterCall(mode, code) {
  role = mode; roomCode = code || ""; inCall = true; ending = false; everConnected = false;
  friend = { name: "", rec: false, secs: 0, db: -120, cls: "", seen: 0 };
  show("homeView", false); show("checkView", false); show("callView", true); banner("");
  $("hangupBtn").disabled = false; $("recBtn").disabled = true; show("savedCard", false);
  requestWakeLock();
  await ensureMic();
  if (mode !== "solo") await loadIce();
  if (mode === "solo") {
    $("roomLabel").textContent = "Solo"; $("roomCode").textContent = "SOLO"; setStatus("Recording without a call.");
    show("friendCard", false); $("muteBtn").disabled = true; $("speakerBtn").disabled = true; $("recBtn").disabled = false;
    return;
  }
  show("friendCard", true); $("muteBtn").disabled = false; $("speakerBtn").disabled = false;
  $("roomCode").textContent = code;
  if (mode === "host") {
    $("roomLabel").textContent = "Text your friend this code";
    peer = await newPeer(PREFIX + code);
    setStatus("Waiting for your friend to join…");
    peer.on("call", (c) => { const old = call; call = null; try { old && old.close(); } catch (e) {} c.answer(sendStream); wireCall(c); });
    peer.on("connection", (c) => { const old = conn; conn = null; try { old && old.close(); } catch (e) {} wireConn(c); });
  } else {
    $("roomLabel").textContent = "Joined call";
    peer = await newPeer();
    setStatus("Connecting…");
    dial();
  }
}
async function hostRoom() {
  for (let tries = 0; tries < 5; tries++) {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[b % 31]).join("");
    try { await enterCall("host", code); return; }
    catch (e) { if (e && e.type === "unavailable-id") continue; throw e; }
  }
}
async function hangUp() {
  ending = true; $("hangupBtn").disabled = true;
  if (recording) await stopRecording(true);
  send({ t: "bye" });
  if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
  await new Promise((r) => setTimeout(r, 300));
  try { call && call.close(); conn && conn.close(); peer && peer.destroy(); } catch (e) {}
  call = null; conn = null; peer = null; inCall = false;
  $("remoteAudio").srcObject = null;
  releaseMic();
  try { wakeLock && wakeLock.release(); } catch (e) {}
  show("callView", false); show("homeView", true); renderHistory();
}

// ---------- screen UI loop ----------
let lastTip = { cls: "", text: "" };
function uiTick() {
  const db = dbOf(peakHold), hot = performance.now() < clipUntil;
  for (const id of ["meterBar", "checkBar"]) { $(id).style.width = pct(db) + "%"; $(id).classList.toggle("hot", hot); }
  $("clip").textContent = hot ? "CLIPPING" : db > -90 ? Math.round(db) + " dB" : "silent";
  $("clip").className = "pill" + (hot ? " bad" : db > -9 ? " ok" : "");
  if (recording) {
    $("timer").textContent = hms(recFrames / RATE);
    $("recState").innerHTML = '<span class="rec-dot"></span>Recording · loudest ' + dbOf(recPeak).toFixed(1) + " dB";
  }
  if (inCall && role !== "solo") {
    const fresh = friend.seen && Date.now() - friend.seen < 5000;
    $("friendName").textContent = friend.name || "Friend";
    const fr = $("friendRec");
    if (!fresh) { fr.textContent = everConnected ? "no signal" : "not connected"; fr.className = "pill"; $("friendInfo").textContent = everConnected ? "Not hearing from their phone right now." : "Their level and recording status show here."; }
    else {
      fr.textContent = friend.rec ? "● recording " + hms(friend.secs) : "not recording"; fr.className = "pill " + (friend.rec ? "on" : recording ? "bad" : "ok");
      $("friendInfo").textContent = "Level " + (friend.db > -90 ? friend.db + " dB" : "silent") + (friend.tip ? " · " + friend.tip : "") +
        (friend.rec && friend.space != null ? " · their space left about " + hm(friend.space) : "") +
        (recording && !friend.rec ? " · Their phone is NOT recording!" : "");
    }
  }
}
setInterval(uiTick, 100);
setInterval(() => {
  if (!micStream) return;
  lastTip = coachAdvice();
  const el = $("coach"); el.textContent = lastTip.text; el.className = "coach " + lastTip.cls;
  sendHeartbeat();
}, 1000);
setInterval(updateQuality, 3000);

// ---------- wake lock, battery, background ----------
let wakeLock = null, hiddenAt = 0;
async function requestWakeLock() {
  if (!S.keepAwake) return;
  try { if ("wakeLock" in navigator) { wakeLock = await navigator.wakeLock.request("screen"); log("Screen will stay on"); } }
  catch (e) { log("Wake lock unavailable: keep the screen on yourself"); }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
  if (inCall && (!wakeLock || wakeLock.released)) requestWakeLock();
  if (ctx && ctx.state !== "running") ctx.resume();
  if (recording && hiddenAt && Date.now() - hiddenAt > 2000) log("The page was in the background for " + Math.round((Date.now() - hiddenAt) / 1000) + " s. Keep it on screen while recording.");
});
(async () => {
  try {
    if (!navigator.getBattery) return;
    const b = await navigator.getBattery();
    const check = () => { if (b.level < 0.2 && !b.charging) banner("Battery is at " + Math.round(b.level * 100) + "%. Plug in before a long recording."); };
    b.addEventListener("levelchange", check); b.addEventListener("chargingchange", check); check();
  } catch (e) {}
})();
window.addEventListener("beforeunload", (e) => { if (recording) { e.preventDefault(); e.returnValue = ""; } });

// ---------- buttons + settings wiring ----------
const fail = (e) => { const m = (e && (e.message || e.type)) || String(e); log("Error: " + m); setStatus("Error: " + m); inCall = false; };
const needName = () => { if (!S.name) { $("myName").focus(); $("myName").placeholder = "Type your name first"; return true; } return false; };
$("newRoomBtn").onclick = () => { if (needName()) return; hostRoom().catch(fail); };
$("joinBtn").onclick = () => {
  if (needName()) return;
  const code = $("codeInput").value.trim().toUpperCase();
  if (code.length !== 4) { $("codeInput").focus(); return; }
  enterCall("guest", code).catch(fail);
};
$("soloBtn").onclick = () => enterCall("solo").catch(fail);
$("homeCheckBtn").onclick = () => openCheck("homeView");
$("callCheckBtn").onclick = () => openCheck("callView");
$("recBtn").onclick = () => beginRecording(false, 3);
$("stopBtn").onclick = () => stopRecording(true);
$("markBtn").onclick = () => addMark(false);
$("muteBtn").onclick = () => {
  muted = !muted;
  if (sendStream) sendStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  $("muteBtn").textContent = muted ? "Unmute call" : "Mute call";
  log(muted ? "Muted on the call (still recording)" : "Unmuted");
};
// Speaker off only silences the friend's voice on this phone (for sitting in the same room).
// The mic is a separate input with auto-gain off, so playback volume never changes the recording.
function applySpeaker() {
  $("remoteAudio").muted = S.speakerOff;
  $("speakerBtn").textContent = S.speakerOff ? "Speaker on" : "Speaker off";
  show("speakerNote", S.speakerOff);
}
$("speakerBtn").onclick = () => { S.speakerOff = !S.speakerOff; saveSettings(); applySpeaker(); log(S.speakerOff ? "Speaker off (mic still recording normally)" : "Speaker on"); };
applySpeaker();
$("hangupBtn").onclick = () => hangUp();

$("myName").value = S.name;
$("myName").oninput = () => { S.name = $("myName").value.trim(); saveSettings(); preview(); };
$("nameTpl").value = S.tpl;
$("nameTpl").oninput = () => { S.tpl = $("nameTpl").value || "{date}_{time}"; saveSettings(); preview(); };
function preview() { $("namePreview").textContent = buildName({ date: new Date().toISOString(), me: S.name, friend: "Alex", room: "K7PQ", role: "host" }); }
$("afterSave").value = S.afterSave;
$("afterSave").onchange = () => { S.afterSave = $("afterSave").value; saveSettings(); if (S.afterSave === "folder" && canPickFolder && !folderHandle) pickFolder(); };
show("folderBox", canPickFolder); show("noFolderNote", !canPickFolder);
if (!canPickFolder) $("afterSave").querySelector('option[value="folder"]').remove();
if (!navigator.canShare) $("afterSave").querySelector('option[value="share"]').remove();
if (!$("afterSave").value) { $("afterSave").value = "download"; S.afterSave = "download"; }
$("pickFolderBtn").onclick = pickFolder;
$("keepAwake").checked = S.keepAwake;
$("keepAwake").onchange = () => {
  S.keepAwake = $("keepAwake").checked; saveSettings();
  if (!S.keepAwake && wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; } else if (inCall) requestWakeLock();
};
$("forceRelay").checked = S.forceRelay;
$("forceRelay").onchange = () => { S.forceRelay = $("forceRelay").checked; saveSettings(); };
$("autoLevel").checked = S.autoLevel;
$("autoLevel").onchange = () => { S.autoLevel = $("autoLevel").checked; saveSettings(); };
$("distance").innerHTML = DISTANCES.map((d) => '<option value="' + d + '">' + cmText(d) + "</option>").join("");
$("distance").value = String(S.distance);
$("distance").onchange = () => { S.distance = +$("distance").value; saveSettings(); };
$("micSelect").onchange = () => { S.micId = $("micSelect").value; saveSettings(); releaseMic(); log("Mic choice saved; it's used from the next check or call"); };
preview();

// ---------- install as an app ----------
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; });
window.addEventListener("appinstalled", () => { show("installBtn", false); log("Installed as an app"); });
// Installed app: swap the Install chip for an Exit button that ends the call, saves any recording,
// releases the mic and closes the app window.
const standaloneMq = matchMedia("(display-mode: standalone)");
const isStandalone = () => standaloneMq.matches || !!navigator.standalone;
function applyMode() { show("installBtn", !isStandalone()); show("exitBtn", isStandalone()); }
standaloneMq.addEventListener ? standaloneMq.addEventListener("change", applyMode) : standaloneMq.addListener(applyMode);
applyMode();
async function exitApp() {
  if (recording && !confirm("You are recording. Stop, save the file, and exit?")) return;
  $("exitBtn").disabled = true;
  const saved = recording;
  if (inCall) await hangUp();
  else if (recording) await stopRecording(true);
  checkSink = null; releaseMic();
  try { wakeLock && wakeLock.release(); } catch (e) {}
  if (saved) await new Promise((r) => setTimeout(r, 1500));    // let the saved file finish downloading
  window.close();
  setTimeout(() => { $("exitBtn").disabled = false; banner("Everything is stopped and saved. If the app didn't close, swipe it away from your recent apps."); }, 500);
}
$("exitBtn").onclick = exitApp;
$("installBtn").onclick = async () => {
  if (!installEvt) { alert("To install: open Chrome's ⋮ menu and tap \"Add to Home screen\", then Install."); return; }
  installEvt.prompt(); await installEvt.userChoice; installEvt = null;
};
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});

window.__app = { history: () => history, getEntryFile };   // used by the automated test

(async () => {
  if (!window.isSecureContext) banner("This page must be opened over https:// for the microphone to work.");
  await initWorker();
  await loadFolder();
  await recoverInterrupted();
  renderHistory();
})();
