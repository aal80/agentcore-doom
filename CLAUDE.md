# agentcore-doom

Run Doom (the game) on Amazon Bedrock AgentCore Runtime (ACR), played from a web browser.

Hard constraint: no WebSockets. Server→browser uses SSE; browser→server uses POST requests to ACR.

ACR uses SigV4 auth, so the browser only talks to `webui/`, which signs requests and forwards them to ACR.

## Layout

- `doom/`: the container deployed to ACR (ARM64, platform V2). It holds:
  - `engine/`: the headless doomgeneric engine, including the sound/music module that emits events.
  - `agent/server.js`: a Node agent that implements ACR's `/ping` + `/invocations` contract. It encodes frames as WebP with `sharp`.
  - `music/render.mjs`: a build-time step that renders the MIDI tracks to MP3.
- `webui/`: the SigV4 proxy (`server.js`) plus the browser client (`public/`). The client shows two panels: the game and a live architecture diagram (`diagram.js`). `LOCAL_AGENT_URL` targets a local container unsigned; `AGENT_RUNTIME_ARN` targets ACR.
- `terraform/`: AWS deployment.
  - `ecr.tf`: the repo plus the image build/push.
  - `ac_runtime_doom.tf`: the AgentCore Runtime and its role. It also writes the runtime ARN to `./tmp/doom_runtime_arn.txt`.
  - `webui.tf`: the webui on Lambda Web Functions.
- `Makefile`:
  - `make local` runs the container on :8080 and the UI on http://localhost:3000.
  - `make deploy` runs `npm ci`, then `terraform init` + `apply`.
  - `make destroy` removes the AWS resources.
  - `make webui-run-acr` runs the local UI against the deployed runtime (reads the ARN file).

## Working rules

- Never run `terraform apply`, `make deploy` or `make destroy`; the user applies. Use `terraform fmt`, `validate` and `plan` only.
- Test the web UI only through the single server on port 3001, which the user watches live. Each browser tab has its own session (game), so test tabs don't touch the user's game.

## Project memory

Read `memory.md` first. It holds verified facts, assumptions, decisions, measurements and open risks for this project. It's local working notes and is git-ignored, so it isn't in the repository.

- After learning anything non-obvious (ACR behavior, limits, test results, design decisions), update `memory.md`.
- Keep `memory.md` **under 20 KB** (`wc -c memory.md`). When it gets close, condense or remove stale entries rather than appending.
- Label entries [FACT] (verified, with source) or [ASSUMPTION].
