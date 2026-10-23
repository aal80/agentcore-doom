// AgentCore Runtime agent that runs Doom.
//
// Implements the ACR HTTP contract on 0.0.0.0:8080:
//   GET  /ping         Healthy / HealthyBusy (busy while at least one browser stream is open)
//   POST /invocations  JSON body, dispatched on "type":
//     {"type":"stream"}                                   -> SSE stream of frames (see below)
//     {"type":"input","events":[{"code":"ArrowUp","down":true}, ...]}  -> JSON ack
//     {"type":"sounds"}                                   -> JSON {sounds: {DSPISTOL: {rate, pcm: base64 u8}}}
//     {"type":"music","lump":"D_E1M1"}                    -> audio/mpeg (pre-rendered at image build time)
//
// One ACR session = one microVM = one container = one game. The Doom process is started lazily on the
// first invocation and restarted if it exits (e.g. the player quits from the menu).
//
// ACR platform version V2 snapshots the agent once it is healthy and restores that snapshot for every new
// session. Everything slow happens before we listen on 8080, so it lands in the snapshot: static data (sounds,
// music index) and the Doom engine itself, started and running at the title screen (its init took ~6 s in a
// freshly restored microVM). Restored sessions resume that game; if it exits, it's restarted on demand.
//
// SSE events:
//   event: hello   data: {"width":320,"height":200,"frameFormat":"webp","sandbox":"<id>","sounds":"<sounds version>"}
//   event: frame   data: base64 of the frame in hello.frameFormat: "webp" (320x200 lossy WebP q85, default) or
//                  "deflate" (deflate-raw(768 bytes RGB palette + 320*200 palette indices), lossless, ~1.5x larger)
//   event: sound   data: [["s",ch,vol,sep,"DSPISTOL"], ["u",ch,vol,sep], ["x",ch], ...]   start/update/stop, one batch
//                  per engine output chunk (~one game tic); vol 0-127, sep 0 (left) - 254 (right)
//   event: music   data: {"op":"play"|"stop"|"pause"|"resume"|"volume","lump":"D_E1M1","loop":true,"vol":0-127}
//                  (current music state is also sent right after hello, so late joiners hear the right track)
//   event: end     data: {"reason":"..."}   (client should reconnect)
//
// Env: DOOM_BIN, DOOM_IWAD, DOOM_ARGS (extra args), PORT, STREAM_MAX_SECONDS, MAX_FPS, FRAME_FORMAT, FRAME_QUALITY

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import sharp from "sharp";
import { readSounds } from "./wad.js";

const PORT = Number(process.env.PORT || 8080);
const DOOM_BIN = process.env.DOOM_BIN || "/game/doomgeneric_headless";
const DOOM_IWAD = process.env.DOOM_IWAD || "/game/freedoom1.wad";
const DOOM_ARGS = (process.env.DOOM_ARGS || "").split(" ").filter(Boolean);
const MUSIC_DIR = process.env.MUSIC_DIR || "/game/music";
// ACR caps a streaming response at 60 min; end it a little earlier so the client reconnects cleanly.
const STREAM_MAX_MS = Number(process.env.STREAM_MAX_SECONDS || 55 * 60) * 1000;
// Optional frame-rate cap to trade smoothness for bandwidth; 0 = send every distinct frame (~35 fps).
const MAX_FPS = Number(process.env.MAX_FPS || 0);
const KEEPALIVE_MS = 15000;
// WebP q85 (user choice): ~20 KB/frame vs ~30 KB lossless deflate (~7.6 vs ~11 Mbit/s at 35 fps), crisp pixel art.
const FRAME_FORMAT = process.env.FRAME_FORMAT === "deflate" ? "deflate" : "webp";
const FRAME_QUALITY = Number(process.env.FRAME_QUALITY || 85);

const WIDTH = 320;
const HEIGHT = 200;
const FRAME_BYTES = 256 * 3 + WIDTH * HEIGHT;
// Engine -> agent records on fd 3 (see engine/headless.h): [type u8][len u32 LE][payload].
const REC_FRAME = 1;
const REC_SOUND = 2;
const REC_MUSIC = 3;
const SOUND_OPS = { 1: "s", 2: "u", 3: "x" }; // start, update, stop
// Sound updates closer than this to what the client last got are inaudible (0.8% gain / pan) and not sent.
const SOUND_VOL_EPS = 1;
const SOUND_SEP_EPS = 2;
const MUSIC_OPS = { 1: "play", 2: "stop", 3: "pause", 4: "resume", 5: "volume" };
const MAX_BODY_BYTES = 64 * 1024;

// KeyboardEvent.code -> Doom key code (doomkeys.h). This is a plain keyboard mapping; which key does what in the
// game is set by the engine's key_* bindings (engine/doomgeneric_headless.c: WASD move/turn, K fire, L use).
const KEY = {
  ArrowRight: 0xae, ArrowLeft: 0xac, ArrowUp: 0xad, ArrowDown: 0xaf, // menus, automap
  Comma: 0x2c, Period: 0x2e,
  Space: 0xa2,               // KEY_USE: unbound now that use is on L
  ControlLeft: 0xa3, ControlRight: 0xa3, // KEY_FIRE: unbound now that fire is on K
  ShiftLeft: 0x80 + 0x36, ShiftRight: 0x80 + 0x36, // run
  AltLeft: 0x80 + 0x38, AltRight: 0x80 + 0x38,     // strafe modifier
  Escape: 27, Enter: 13, Tab: 9, Backspace: 0x7f,
  Minus: 0x2d, Equal: 0x3d,
  F1: 0x80 + 0x3b, F2: 0x80 + 0x3c, F3: 0x80 + 0x3d, F4: 0x80 + 0x3e, F5: 0x80 + 0x3f,
  F6: 0x80 + 0x40, F7: 0x80 + 0x41, F8: 0x80 + 0x42, F9: 0x80 + 0x43, F10: 0x80 + 0x44,
  F11: 0x80 + 0x57, F12: 0x80 + 0x58,
};
for (let c = 65; c <= 90; c++) KEY[`Key${String.fromCharCode(c)}`] = c + 32; // KeyA -> 'a'
for (let d = 0; d <= 9; d++) KEY[`Digit${d}`] = 48 + d;

// ---- Doom process ----

let doom = null;
const streams = new Set();

// Resolves when the engine has drawn its first frame, i.e. finished initializing.
const firstFrame = Promise.withResolvers();

function startDoom() {
  if (doom) return doom;
  const args = ["-iwad", DOOM_IWAD, ...DOOM_ARGS];
  console.log(`starting ${DOOM_BIN} ${args.join(" ")}`);
  const proc = spawn(DOOM_BIN, args, { stdio: ["pipe", "inherit", "inherit", "pipe"], cwd: "/tmp" });

  let pending = Buffer.alloc(0);
  proc.stdio[3].on("data", (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let latest = null;
    const sounds = [];
    while (pending.length >= 5) {
      const len = pending.readUInt32LE(1);
      if (pending.length < 5 + len) break;
      const type = pending[0];
      const payload = pending.subarray(5, 5 + len);
      pending = pending.subarray(5 + len);
      if (type === REC_FRAME && len === FRAME_BYTES) {
        latest = payload;
        firstFrame.resolve();
      }
      else if (type === REC_SOUND) queueSound(payload, sounds);
      else if (type === REC_MUSIC) onMusic(payload);
    }
    // Only the newest frame of a chunk matters; its sound events go out first, as one batch.
    if (sounds.length) broadcastSounds(sounds);
    if (latest) broadcastFrame(Buffer.from(latest));
  });
  proc.stdin.on("error", () => {});
  proc.on("exit", (code, signal) => {
    console.log(`doom exited code=${code} signal=${signal}`);
    if (doom === proc) doom = null;
    for (const s of streams) endStream(s, "doom exited");
  });
  doom = proc;
  return proc;
}

let lastFrame = null; // newest distinct frame from the engine
let lastFrameMsg = null; // its SSE message, once encoded
let lastSentAt = 0;
let encoding = false;

function broadcastFrame(frame) {
  // Doom redraws ~2x per game tic; about half the frames are byte-identical to the previous one.
  if (lastFrame?.equals(frame)) return;
  const now = Date.now();
  if (MAX_FPS && now - lastSentAt < (1000 / MAX_FPS) * 0.8) return;
  lastFrame = frame;
  lastFrameMsg = null;
  if (streams.size === 0) return;
  lastSentAt = now;
  if (!encoding) encodeAndSend();
}

// Encodes the newest frame (WebP runs in libvips' thread pool, off the event loop) and sends it to every stream.
// Frames that arrive during an encode replace each other, so a slow encode drops frames instead of queueing.
async function encodeAndSend() {
  encoding = true;
  try {
    while (lastFrame && !lastFrameMsg && streams.size > 0) {
      const frame = lastFrame;
      const msg = await encodeFrame(frame);
      if (lastFrame === frame) lastFrameMsg = msg;
      for (const s of streams) {
        // Drop frames for slow clients instead of queueing; they'll get the next one.
        if (s.res.writableNeedDrain) {
          s.dropped++;
          continue;
        }
        s.res.write(msg);
        s.sent++;
      }
    }
  } catch (err) {
    console.error(`frame encoding failed: ${err.message}`);
  } finally {
    encoding = false;
  }
}

// Reused for every WebP encode; only one encode runs at a time.
const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);

async function encodeFrame(frame) {
  let data;
  if (FRAME_FORMAT === "webp") {
    for (let p = 0; p < WIDTH * HEIGHT; p++) {
      const c = frame[768 + p] * 3;
      rgb[p * 3] = frame[c];
      rgb[p * 3 + 1] = frame[c + 1];
      rgb[p * 3 + 2] = frame[c + 2];
    }
    data = await sharp(rgb, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
      .webp({ quality: FRAME_QUALITY, effort: 2 })
      .toBuffer();
  } else {
    data = zlib.deflateRawSync(frame, { level: 6 });
  }
  return `event: frame\ndata: ${data.toString("base64")}\n\n`;
}

// Last vol/sep sent per channel, to skip inaudible updates.
const soundSent = new Map();

// Adds one engine sound event to the current batch, coalescing per channel: an update folds into a start or
// update already in the batch, a stop drops a pending update, and an update too small to hear is skipped.
function queueSound(p, batch) {
  const [op, ch, vol, sep] = [SOUND_OPS[p[0]], p[1], p[2], p[3]];
  const prev = batch.findLast((e) => e[1] === ch);
  if (op === "u") {
    if (prev && prev[0] !== "x") {
      prev[2] = vol;
      prev[3] = sep;
      return;
    }
    const last = soundSent.get(ch);
    if (last && Math.abs(last.vol - vol) <= SOUND_VOL_EPS && Math.abs(last.sep - sep) <= SOUND_SEP_EPS) return;
    batch.push([op, ch, vol, sep]);
  } else if (op === "s") {
    batch.push([op, ch, vol, sep, p.toString("latin1", 4, 12).replace(/\0.*$/, "").toUpperCase()]);
  } else {
    if (prev?.[0] === "u") batch.splice(batch.lastIndexOf(prev), 1);
    batch.push([op, ch]);
  }
}

function broadcastSounds(batch) {
  if (streams.size === 0) return;
  for (const [op, ch, vol, sep] of batch) {
    if (op === "x") soundSent.delete(ch);
    else soundSent.set(ch, { vol, sep });
  }
  // Never dropped (unlike frames): they're tiny and a lost stop would leave a sound playing.
  const msg = `event: sound\ndata: ${JSON.stringify(batch)}\n\n`;
  for (const s of streams) s.res.write(msg);
}

// Current music state, replayed to streams that connect later (reload, reconnect after 60 min).
const music = { lump: null, loop: false, vol: 127, paused: false };

function onMusic(p) {
  const op = MUSIC_OPS[p[0]];
  music.vol = p[2];
  if (op === "play") {
    Object.assign(music, { lump: p.toString("latin1", 4, 12).replace(/\0.*$/, "").toUpperCase(), loop: p[1] === 1, paused: false });
  } else if (op === "stop") music.lump = null;
  else if (op === "pause") music.paused = true;
  else if (op === "resume") music.paused = false;
  const ev = { op, lump: music.lump, loop: music.loop, vol: music.vol };
  const msg = `event: music\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const s of streams) s.res.write(msg);
}

function musicStateMessage() {
  const ev = music.lump
    ? { op: music.paused ? "pause" : "play", lump: music.lump, loop: music.loop, vol: music.vol }
    : { op: "stop", lump: null, loop: false, vol: music.vol };
  return `event: music\ndata: ${JSON.stringify(ev)}\n\n`;
}

// ---- /ping status ----

// time_of_last_update is optional and omitted: a startup timestamp would be frozen into the V2 snapshot,
// and without it the platform tracks status changes itself.
let pingStatus = "Healthy";

function updatePingStatus() {
  pingStatus = streams.size > 0 ? "HealthyBusy" : "Healthy";
}

// ---- Invocation handlers ----

// Identifies this sandbox (microVM), so clients can check that all their requests land on the same one. Created
// on first use, i.e. after a V2 snapshot restore; a value made at startup would be shared by every instance,
// and hostname/PID are identical across restored instances too.
let sandboxId = null;
const sandbox = () => (sandboxId ??= crypto.randomBytes(4).toString("hex"));

function handleStream(req, res) {
  startDoom();
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
  const hello = { width: WIDTH, height: HEIGHT, frameFormat: FRAME_FORMAT, sandbox: sandbox(), sounds: soundsVersion };
  res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
  res.write(musicStateMessage());

  const s = { res, sent: 0, dropped: 0, opened: Date.now() };
  s.timer = setTimeout(() => endStream(s, "max stream duration"), STREAM_MAX_MS);
  // Frames stop while the picture is static (e.g. paused); keep intermediaries from idling the stream out.
  s.keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
  streams.add(s);
  // The current picture right away: cached if already encoded, otherwise encode it now (for every stream).
  if (lastFrameMsg) res.write(lastFrameMsg);
  else if (!encoding) encodeAndSend();
  updatePingStatus();
  console.log(`stream opened (${streams.size} open)`);

  res.on("close", () => {
    clearTimeout(s.timer);
    clearInterval(s.keepalive);
    streams.delete(s);
    updatePingStatus();
    console.log(`stream closed after ${Math.round((Date.now() - s.opened) / 1000)}s sent=${s.sent} dropped=${s.dropped} (${streams.size} open)`);
  });
}

function endStream(s, reason) {
  if (!streams.has(s)) return;
  s.res.end(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
}

function handleInput(msg, res) {
  const events = Array.isArray(msg.events) ? msg.events : [];
  const bytes = [];
  for (const e of events) {
    const key = KEY[e?.code];
    if (key !== undefined) bytes.push(e.down ? 1 : 0, key);
  }
  const proc = startDoom();
  if (bytes.length) proc.stdin.write(Buffer.from(bytes));
  sendJson(res, 200, { ok: true, accepted: bytes.length / 2, sandbox: sandbox() });
}

// Static data, loaded at startup (before the V2 snapshot): sound samples from the IWAD, serialized once, and
// the music lump -> MP3 index written by music/render.mjs at image build time.
const soundsJson = (() => {
  const out = {};
  for (const [name, { rate, pcm }] of Object.entries(readSounds(DOOM_IWAD))) out[name] = { rate, pcm: pcm.toString("base64") };
  const json = JSON.stringify({ sounds: out });
  console.log(`loaded ${Object.keys(out).length} sounds from ${DOOM_IWAD} (${json.length} bytes JSON)`);
  return json;
})();
// Lets browsers cache the sounds and only download them again when they change.
const soundsVersion = crypto.createHash("sha1").update(soundsJson).digest("hex").slice(0, 12);
const musicIndex = JSON.parse(fs.readFileSync(path.join(MUSIC_DIR, "index.json"), "utf8"));

function handleSounds(res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(soundsJson);
}

function handleMusic(msg, res) {
  const file = Object.hasOwn(musicIndex, msg.lump) && musicIndex[msg.lump];
  if (!file) return sendJson(res, 404, { error: `no music for lump: ${msg.lump}` });
  const full = path.join(MUSIC_DIR, file);
  res.writeHead(200, { "content-type": "audio/mpeg", "content-length": fs.statSync(full).size });
  fs.createReadStream(full).pipe(res);
}

// ---- HTTP plumbing ----

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Body must be JSON"), { status: 400 });
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer({ noDelay: true }, async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/ping") {
      return sendJson(res, 200, { status: pingStatus });
    }
    if (req.method === "POST" && req.url.split("?")[0] === "/invocations") {
      const msg = await readJson(req);
      if (msg.type === "stream") return handleStream(req, res);
      if (msg.type === "input") return handleInput(msg, res);
      if (msg.type === "sounds") return handleSounds(res);
      if (msg.type === "music") return handleMusic(msg, res);
      return sendJson(res, 400, { error: `unknown type: ${msg.type}` });
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    console.error(`${req.method} ${req.url}: ${err.message}`);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
  }
});

// Start Doom first and only listen (= become healthy, = get snapshotted on V2) once it has drawn a frame.
const startedAt = Date.now();
startDoom();
await Promise.race([firstFrame.promise, new Promise((r) => setTimeout(r, 60_000))]);
console.log(`doom ready after ${Date.now() - startedAt} ms`);
// Warm up the encoder too, so libvips is initialized in the V2 snapshot.
if (lastFrame) await encodeFrame(lastFrame);
console.log(`frame encoder (${FRAME_FORMAT}) ready after ${Date.now() - startedAt} ms`);
server.listen(PORT, "0.0.0.0", () => console.log(`doom agent listening on :${PORT}`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    doom?.kill("SIGTERM");
    process.exit(0);
  });
}
