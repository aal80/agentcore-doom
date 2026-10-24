// Doom web UI server: serves the browser client from ./public and bridges it to Bedrock AgentCore Runtime (ACR).
//
// Browser-facing contract: POST /invocations with a JSON body, as before. Each browser tab is its own game: it
// sends a random 32-char id in the X-Doom-Session header on every request, and that id (prefixed, see
// acrSessionId) is the ACR session id. The same session id keeps routing to the same sandbox (microVM, with its
// running game); a new id gets a new sandbox.
//   {"type":"stream"}  SSE: hello, music, frame (base64), sound, end; relayed from the session's WebSocket
//   {"type":"input"}   {"events":[...]} sent over the session's WebSocket
//   anything else      (sounds, music) proxied to ACR as one InvokeAgentRuntime call, response piped back
//
// Towards ACR this keeps one WebSocket per session per execution environment (InvokeAgentRuntimeWithWebSocketStream,
// SigV4-signed handshake). The browser itself never uses WebSockets. On ACR:
//   - nothing the agent sends arrives before the client's first message, so we open with {"t":"hello"};
//   - a connection without traffic is closed after ~60 s, so we ping while it's open;
//   - a frame over 64 KB closes the connection (the agent keeps frames below that).
//
// Env:
//   AGENT_RUNTIME_ARN  ACR runtime ARN (required unless LOCAL_AGENT_URL is set)
//   AWS_REGION         defaults to the region in AGENT_RUNTIME_ARN
//   QUALIFIER          runtime endpoint name, default DEFAULT
//   LOCAL_AGENT_URL    e.g. http://localhost:8080 - talk to a locally running container, unsigned
//   STATIC_DIR         directory served at /, default ./public (same-origin with /invocations, no CORS needed)
//   PORT               default 3000 (ignored on Lambda Web Functions, which set AWS_LAMBDA_HTTP_ENDPOINT=host:port)

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import WebSocket from "ws";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { SignatureV4 } from "@smithy/signature-v4";

const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";
// The browser's game session id: 32 hex chars (a UUID without hyphens).
const BROWSER_SESSION_HEADER = "x-doom-session";
const BROWSER_SESSION_RE = /^[0-9a-f]{32}$/i;
const MAX_BODY_BYTES = 1024 * 1024;
// Lambda Web Functions end a request at the 900 s timeout; end streams a bit earlier so the client reconnects.
const STREAM_MAX_MS = 840_000;
const KEEPALIVE_MS = 15_000;
// ACR closes a WebSocket after ~60 s without traffic (measured); a paused game sends nothing, so ping.
const WS_PING_MS = 20_000;
// Keep an unused WebSocket this long after the last stream or input, then close it.
const WS_LINGER_MS = 30_000;
// Forget a session this long after its last use.
const SESSION_IDLE_MS = 60_000;
const HELLO_TIMEOUT_MS = 30_000;
// Opening a WebSocket to a session that ACR is still provisioning returns 409 RetryableConflictException.
const CONNECT_ATTEMPTS = 6;

const { AGENT_RUNTIME_ARN, LOCAL_AGENT_URL } = process.env;
const STATIC_DIR = process.env.STATIC_DIR || path.join(import.meta.dirname, "public");
const QUALIFIER = process.env.QUALIFIER || "DEFAULT";
// On Lambda Web Functions the runtime says where to listen; locally listen on all interfaces (IPv4 + IPv6).
const [HOST, PORT] = process.env.AWS_LAMBDA_HTTP_ENDPOINT?.split(":") ?? [undefined, process.env.PORT || 3000];

if (!AGENT_RUNTIME_ARN && !LOCAL_AGENT_URL) {
  console.error("Set AGENT_RUNTIME_ARN (or LOCAL_AGENT_URL for local development)");
  process.exit(1);
}

const region = process.env.AWS_REGION || AGENT_RUNTIME_ARN?.split(":")[3];
const acr = AGENT_RUNTIME_ARN && new BedrockAgentCoreClient({
  region,
  requestHandler: new NodeHttpHandler({
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 1000 }),
    requestTimeout: 0,
  }),
});
// Signs WebSocket handshakes with the same credentials the SDK client uses (the execution role on Lambda).
const signer = acr && new SignatureV4({
  service: "bedrock-agentcore",
  region,
  credentials: acr.config.credentials,
  sha256: acr.config.sha256,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large"), { name: "PayloadTooLargeException", status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ---- One-shot calls (sounds, music): InvokeAgentRuntime, response piped back ----

// Returns { status, contentType, sessionId, body: Readable }.
async function invokeAcr(payload, sessionId, signal) {
  const out = await acr.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: AGENT_RUNTIME_ARN,
    qualifier: QUALIFIER,
    runtimeSessionId: sessionId,
    contentType: "application/json",
    accept: "application/json, text/event-stream",
    payload,
  }), { abortSignal: signal });
  return { status: out.statusCode || 200, contentType: out.contentType, sessionId: out.runtimeSessionId, body: out.response };
}

async function invokeLocal(payload, sessionId, signal) {
  const res = await fetch(new URL("/invocations", LOCAL_AGENT_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      [SESSION_HEADER]: sessionId,
    },
    body: payload,
    signal,
  });
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    sessionId,
    body: res.body && Readable.fromWeb(res.body),
  };
}

async function proxyInvocation(payload, sessionId, res) {
  // Abort the upstream call when the browser goes away.
  const upstream = new AbortController();
  res.on("close", () => upstream.abort());

  const invoke = acr ? invokeAcr : invokeLocal;
  const out = await invoke(payload, sessionId, upstream.signal);

  res.writeHead(out.status, {
    "content-type": out.contentType || "application/octet-stream",
    "cache-control": "no-cache",
    ...(out.sessionId && { [SESSION_HEADER]: out.sessionId }),
  });
  if (!out.body) return res.end();
  out.body.on("error", () => res.destroy());
  out.body.pipe(res);
}

// ---- Sessions: one per ACR session this execution environment talks to ----

// sessionId -> { id, link, clients, hello, musicState, lastFrameSse, lingerTimer, lastUsed }
const sessions = new Map();

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { id, clients: new Set(), link: null, hello: null, musicState: null, lastFrameSse: null, lingerTimer: null };
    sessions.set(id, s);
  }
  s.lastUsed = Date.now();
  return s;
}

setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.link && s.clients.size === 0 && Date.now() - s.lastUsed > SESSION_IDLE_MS) sessions.delete(s.id);
  }
}, SESSION_IDLE_MS).unref();

// ---- WebSocket link to the session's agent (one per session) ----

// Where and how to open the session's WebSocket. Signed again for every attempt (the signature is time-bound).
async function linkTarget(sessionId) {
  if (!acr) {
    const url = new URL("/ws", LOCAL_AGENT_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return { url: url.toString(), headers: { [SESSION_HEADER]: sessionId } };
  }
  const hostname = `bedrock-agentcore.${region}.amazonaws.com`;
  const pathname = `/runtimes/${encodeURIComponent(AGENT_RUNTIME_ARN)}/ws`;
  const query = QUALIFIER === "DEFAULT" ? {} : { qualifier: QUALIFIER };
  const signed = await signer.sign({
    method: "GET",
    protocol: "https:",
    hostname,
    path: pathname,
    query,
    headers: { host: hostname, [SESSION_HEADER]: sessionId },
  });
  const qs = new URLSearchParams(query).toString();
  return { url: `wss://${hostname}${pathname}${qs ? `?${qs}` : ""}`, headers: signed.headers };
}

// Opens a WebSocket; a refused handshake rejects with the HTTP status and ACR's error type.
async function dial(sessionId) {
  const { url, headers } = await linkTarget(sessionId);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, perMessageDeflate: false });
    ws.once("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        const name = res.headers["x-amzn-errortype"]?.split(":")[0] || "WebSocketHandshakeFailed";
        reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`), { name, status: res.statusCode }));
      });
      ws.terminate();
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function sseToClients(s, msg, { frame = false } = {}) {
  for (const c of s.clients) {
    if (frame && c.res.writableNeedDrain) continue; // slow browser: skip this frame
    c.res.write(msg);
    c.bytes += msg.length;
    if (frame) c.frames++;
  }
}

async function openLink(s) {
  if (s.link) return s.link.ready;
  const link = { ws: null, ping: null, hello: Promise.withResolvers() };
  s.link = link;
  link.ready = (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        link.ws = await dial(s.id);
        break;
      } catch (err) {
        if (err.status !== 409 || attempt >= CONNECT_ATTEMPTS) throw err;
        await sleep(200 * 2 ** attempt);
      }
    }
    const ws = link.ws;
    if (s.link !== link) {
      ws.terminate();
      throw new Error("link closed while connecting");
    }
    ws.on("message", (data, isBinary) => onLinkMessage(s, data, isBinary));
    ws.on("close", (code, reason) => onLinkClosed(s, link, code, reason));
    ws.on("error", (err) => console.error(`session ${s.id} websocket error: ${err.message}`));
    // We speak first: until we do, ACR doesn't pass anything from the agent through.
    ws.send(JSON.stringify({ t: "hello" }));
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no hello from the agent within ${HELLO_TIMEOUT_MS / 1000}s`)), HELLO_TIMEOUT_MS);
    });
    try {
      await Promise.race([link.hello.promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
    link.ping = setInterval(() => ws.ping(), WS_PING_MS);
    console.log(`session ${s.id} websocket open (sandbox ${s.hello?.sandbox})`);
    syncSubscription(s);
  })();
  link.ready.catch((err) => {
    console.error(`session ${s.id} websocket failed: ${err.name}: ${err.message}`);
    if (s.link === link) closeLink(s, "connect failed");
  });
  return link.ready;
}

function onLinkMessage(s, data, isBinary) {
  if (isBinary) {
    s.lastFrameSse = `event: frame\ndata: ${data.toString("base64")}\n\n`;
    return sseToClients(s, s.lastFrameSse, { frame: true });
  }
  let msg;
  try {
    msg = JSON.parse(data.toString("utf8"));
  } catch {
    return;
  }
  const { t, ...body } = msg;
  if (t === "hello") {
    s.hello = body;
    s.link?.hello.resolve();
  }
  if (t === "music") s.musicState = body;
  if (t === "sound") return sseToClients(s, `event: sound\ndata: ${JSON.stringify(body.ev)}\n\n`);
  sseToClients(s, `event: ${t}\ndata: ${JSON.stringify(body)}\n\n`);
}

function onLinkClosed(s, link, code, reason) {
  if (s.link !== link) return;
  clearInterval(link.ping);
  s.link = null;
  console.log(`session ${s.id} websocket closed (${code}${reason?.length ? ` ${reason}` : ""}), ${s.clients.size} streams open`);
  // Browsers reconnect on end; the next stream reopens the link.
  sseToClients(s, `event: end\ndata: ${JSON.stringify({ reason: "agent connection closed" })}\n\n`);
  for (const c of s.clients) c.res.end();
}

function closeLink(s, reason) {
  const link = s.link;
  if (!link) return;
  clearInterval(link.ping);
  s.link = null;
  console.log(`session ${s.id} websocket closing (${reason})`);
  if (link.ws?.readyState === WebSocket.OPEN) link.ws.close(1000, reason);
  else link.ws?.terminate();
}

// Frames and audio flow only while a browser is watching this session through this environment.
function syncSubscription(s) {
  const ws = s.link?.ws;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "subscribe", on: s.clients.size > 0 }));
  clearTimeout(s.lingerTimer);
  if (s.clients.size === 0) s.lingerTimer = setTimeout(() => s.clients.size === 0 && closeLink(s, "idle"), WS_LINGER_MS);
}

// ---- Browser handlers ----

async function handleStream(s, res) {
  await openLink(s);
  if (res.destroyed) return; // the browser left while the link was connecting
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
  if (s.hello) res.write(`event: hello\ndata: ${JSON.stringify(s.hello)}\n\n`);
  if (s.musicState) res.write(`event: music\ndata: ${JSON.stringify(s.musicState)}\n\n`);
  if (s.lastFrameSse) res.write(s.lastFrameSse);

  const c = { res, opened: Date.now(), frames: 0, bytes: 0 };
  c.keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
  c.timer = setTimeout(() => res.end(`event: end\ndata: ${JSON.stringify({ reason: "max stream duration" })}\n\n`), STREAM_MAX_MS);
  s.clients.add(c);
  syncSubscription(s);
  console.log(`stream opened for ${s.id} (${s.clients.size} open)`);

  // One log line (-> CloudWatch on Lambda) per stream.
  res.on("close", () => {
    clearInterval(c.keepalive);
    clearTimeout(c.timer);
    s.clients.delete(c);
    s.lastUsed = Date.now();
    syncSubscription(s);
    const secs = ((Date.now() - c.opened) / 1000).toFixed(1);
    console.log(`stream closed for ${s.id} after ${secs}s, ${c.frames} frames, ${(c.bytes / 1e6).toFixed(1)} MB (${s.clients.size} open)`);
  });
}

async function handleInput(s, msg, res) {
  await openLink(s);
  const ws = s.link?.ws;
  if (ws?.readyState !== WebSocket.OPEN) throw Object.assign(new Error("agent connection closed"), { status: 503, name: "AgentUnavailable" });
  ws.send(JSON.stringify({ t: "input", events: Array.isArray(msg.events) ? msg.events : [] }));
  syncSubscription(s); // restarts the linger timer for input-only environments
  sendJson(res, 200, { ok: true });
}

// ACR session ids must be 33-256 chars, so the browser's 32-char id gets a prefix.
const acrSessionId = (browserId) => `doom-${browserId.toLowerCase()}`;

async function handleInvocation(req, res) {
  // Required: without a session id, ACR would start a new sandbox (a new game) for every request.
  const browserId = req.headers[BROWSER_SESSION_HEADER];
  if (!BROWSER_SESSION_RE.test(browserId ?? "")) {
    return sendJson(res, 400, { error: "ValidationException", message: "X-Doom-Session header required: 32 hex chars" });
  }
  const sessionId = acrSessionId(browserId);
  const payload = await readBody(req);
  let msg;
  try {
    msg = JSON.parse(payload.toString("utf8") || "{}");
  } catch {
    return sendJson(res, 400, { error: "ValidationException", message: "Body must be JSON" });
  }
  if (msg.type === "stream") return handleStream(getSession(sessionId), res);
  if (msg.type === "input") return handleInput(getSession(sessionId), msg, res);
  return proxyInvocation(payload, sessionId, res);
}

// ---- Static files, plumbing ----

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serveStatic(req, res) {
  const root = path.resolve(STATIC_DIR);
  const { pathname } = new URL(req.url, "http://localhost");
  const file = path.join(root, path.normalize(pathname === "/" ? "/index.html" : pathname));
  if (!file.startsWith(root + path.sep)) return sendJson(res, 403, { error: "Forbidden" });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: "NotFound" });
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

function sendJson(res, status, obj) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer({ noDelay: true }, async (req, res) => {
  try {
    if (req.method === "POST" && req.url.split("?")[0] === "/invocations") return await handleInvocation(req, res);
    if (req.method === "GET" && req.url === "/healthz") return sendJson(res, 200, { status: "ok" });
    // Lets the UI label the architecture diagram with where requests go. Only what the UI shows: this is public,
    // so no runtime ARN (it contains the account ID).
    if (req.method === "GET" && req.url === "/config") {
      return sendJson(res, 200, acr ? { mode: "acr", region } : { mode: "local", target: LOCAL_AGENT_URL });
    }
    if (req.method === "GET") return serveStatic(req, res);
    sendJson(res, 404, { error: "NotFound" });
  } catch (err) {
    if (err.name === "AbortError") return;
    const status = err.status || err.$metadata?.httpStatusCode || 502;
    console.error(`${req.method} ${req.url} -> ${status} ${err.name}: ${err.message}`);
    sendJson(res, status, { error: err.name, message: err.message });
  }
});

server.listen(Number(PORT), HOST, () => {
  console.log(`agentcore-doom webui on :${PORT} -> ${acr ? `${AGENT_RUNTIME_ARN} (${QUALIFIER})` : LOCAL_AGENT_URL}`);
});
