// Live architecture diagram: arrows light up when traffic of a given kind flows.
// The browser only observes its own requests and stream events; the later/earlier hops are inferred from them
// (every request crosses all hops, every stream event originates in the engine) and animated as a ripple.

const HOLD_MS = 120; // how long an arrow stays lit after its last pulse
const HOP_MS = 40;   // ripple delay between hops

// Arrow ids per traffic kind, in the order the traffic travels.
const PATHS = {
  input: ["req-1", "req-2", "req-3"], // browser -> webui -> agent -> engine stdin
  fetch: ["req-1", "req-2"],          // sound/music downloads are served by the agent
  frame: ["vid-3", "vid-2", "vid-1"], // engine -> agent -> webui -> browser
  audio: ["aud-3", "aud-2", "aud-1"],
};

const timers = new Map();

function light(id, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.kind = kind;
  el.classList.add("hot");
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => el.classList.remove("hot"), HOLD_MS));
}

export function pulse(kind) {
  PATHS[kind]?.forEach((id, hop) => (hop === 0 ? light(id, kind) : setTimeout(() => light(id, kind), hop * HOP_MS)));
}

export function setRates({ req, vid, aud }) {
  document.getElementById("rate-req").textContent = req;
  document.getElementById("rate-vid").textContent = vid;
  document.getElementById("rate-aud").textContent = aud;
}

// Label the diagram with where the webui actually sends requests (real ACR or a local container).
export async function loadConfig() {
  try {
    const cfg = await (await fetch("/config")).json();
    if (cfg.mode === "local") {
      document.getElementById("runtime-title").textContent = "Local container";
      document.getElementById("runtime-sub").textContent = `ACR stand-in · ${cfg.target}`;
      document.getElementById("webui-sub").textContent = "static files · proxy (local mode, unsigned)";
      document.getElementById("hop2-req").textContent = "POST /invocations";
      document.getElementById("hop2-auth").textContent = "unsigned";
    } else {
      document.getElementById("runtime-sub").textContent = `microVM per session · ${cfg.region}`;
    }
  } catch (err) {
    console.warn("diagram config:", err);
  }
}
