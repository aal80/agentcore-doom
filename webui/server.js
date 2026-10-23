// Doom web UI server: serves the browser client from ./public and proxies /invocations to
// Bedrock AgentCore Runtime (ACR), adding SigV4 signatures.
//
// Browser-facing contract mirrors ACR's own: POST /invocations with a JSON body; the response (JSON or SSE) is
// piped back unbuffered. Each browser tab is its own game: it sends a random 32-char id in the X-Doom-Session
// header on every request, and that id (prefixed, see acrSessionId) is the ACR session id. The same session id
// keeps routing to the same sandbox (microVM, with its running game); a new id gets a new sandbox.
//
// Env:
//   AGENT_RUNTIME_ARN  ACR runtime ARN (required unless LOCAL_AGENT_URL is set)
//   AWS_REGION         defaults to the region in AGENT_RUNTIME_ARN
//   QUALIFIER          runtime endpoint name, default DEFAULT
//   LOCAL_AGENT_URL    e.g. http://localhost:8080 - forward to a locally running container, unsigned
//   STATIC_DIR         directory served at /, default ./public (same-origin with /invocations, no CORS needed)
//   PORT               default 3000 (ignored on Lambda Web Functions, which set AWS_LAMBDA_HTTP_ENDPOINT=host:port)

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";
// The browser's game session id: 32 hex chars (a UUID without hyphens).
const BROWSER_SESSION_HEADER = "x-doom-session";
const BROWSER_SESSION_RE = /^[0-9a-f]{32}$/i;
const MAX_BODY_BYTES = 1024 * 1024;

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
  // Each SSE stream holds a socket for up to 60 min; the default pool (50) would starve input POSTs.
  requestHandler: new NodeHttpHandler({
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 1000 }),
    requestTimeout: 0,
  }),
});

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

// ACR session ids must be 33-256 chars, so the browser's 32-char id gets a prefix.
const acrSessionId = (browserId) => `doom-${browserId.toLowerCase()}`;

async function handleInvocation(req, res) {
  // Required: without a session id, ACR would start a new sandbox (a new game) for every request.
  const browserId = req.headers[BROWSER_SESSION_HEADER];
  if (!BROWSER_SESSION_RE.test(browserId ?? "")) {
    return sendJson(res, 400, { error: "ValidationException", message: "X-Doom-Session header required: 32 hex chars" });
  }
  const payload = await readBody(req);

  // Abort the upstream call when the browser goes away, so ACR streams don't leak.
  const upstream = new AbortController();
  res.on("close", () => upstream.abort());

  const invoke = acr ? invokeAcr : invokeLocal;
  const out = await invoke(payload, acrSessionId(browserId), upstream.signal);

  res.writeHead(out.status, {
    "content-type": out.contentType || "application/octet-stream",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
    ...(out.sessionId && { [SESSION_HEADER]: out.sessionId }),
  });
  if (!out.body) return res.end();
  logStreamEnd(payload, out.body, res);
  out.body.on("error", () => res.destroy());
  out.body.pipe(res);
}

// One log line (-> CloudWatch on Lambda) when an SSE stream ends, says why: upstream finished, upstream error
// (e.g. ACR cutting a response at ~100 MB), or the browser went away. Other request types aren't logged.
function logStreamEnd(payload, body, res) {
  let type;
  try {
    type = JSON.parse(payload).type;
  } catch {}
  if (type !== "stream") return;

  const started = Date.now();
  let bytes = 0;
  let logged = false;
  const log = (how, err) => {
    if (logged) return;
    logged = true;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const mb = (bytes / 1e6).toFixed(1);
    const line = `stream ${how} after ${secs}s, ${mb} MB${err ? `: ${err.name}: ${err.message}` : ""}`;
    (err ? console.error : console.log)(line);
  };
  body.on("data", (chunk) => (bytes += chunk.length));
  body.on("end", () => log("ended by runtime"));
  body.on("error", (err) => log("failed", err));
  res.on("close", () => log("closed by client"));
}

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
  console.log(`agentcore-doom proxy on :${PORT} -> ${acr ? `${AGENT_RUNTIME_ARN} (${QUALIFIER})` : LOCAL_AGENT_URL}`);
});
