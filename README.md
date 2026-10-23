# Can it run DOOM: AWS Bedrock AgentCore

This is an experiment of running Doom on [Amazon Bedrock AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html), played in a web browser.

<img src="docs/architecture.png">

> IMPORTANT: This project does not implement authentication. Anyone with your web UI URL can play, every tab is a separate AgentCore session, and you pay for the AWS resources they use. Be careful who you share it with and run `make destroy` to clean up after you're done playing. 

The game engine runs in an AgentCore Runtime v2. The browser draws the frames it receives, plays the sounds, and sends key presses back. There are no WebSockets: the server streams to the browser with Server-Sent Events (SSE), and the browser sends input as plain POST requests, hence expect minor lags. 

## How it works

- **Browser** (`webui/public`): a start screen (**Let's play DOOM** with full sound, or with sounds off), then the game on a canvas, sound effects and music with Web Audio (a sound on/off control in the top right corner), and key presses. A live diagram next to the game shows the traffic.
- **webui** (`webui/server.js`): serves the page and proxies every request to AgentCore Runtime, signing it with SigV4. It runs on AWS Lambda Web Functions.
  - Every browser tab is its own game. On startup the page generates a random 32-character session ID and sends it with every request; the webui uses it as the AgentCore session ID, so each tab gets its own runtime session (microVM) and game. A reload starts a new game.
- **AgentCore Runtime** (`doom/`): an ARM64 container on platform version V2, so new sessions start from a snapshot. Inside it:
  - **agent** (`doom/agent`): a Node.js server that implements `/invocations` and `/ping`. It turns engine output into SSE events and key presses into engine input.
  - **doomgeneric** (`doom/engine`): a headless build of [doomgeneric](https://github.com/ozkl/doomgeneric) playing [Freedoom](https://freedoom.github.io/). It writes frames and sound/music events to the agent and reads keys from it.

Every request is a `POST /invocations` whose JSON `type` says what it is:

| Type | What it does |
| --- | --- |
| `stream` | Opens a long-lived SSE stream of frames (320×200 WebP) plus sound and music events. |
| `input` | Sends key presses. |
| `sounds`, `music` | Download the sound effect samples (cached in the browser) and the music tracks. Music is pre-rendered to MP3 when the image is built. |

The arrows in the diagram light up live in the UI as traffic flows.

## Run it

**Locally (Docker):**

```sh
make local    # builds the image, runs it on :8080, serves the UI on http://localhost:3000
```

**On AWS (Terraform, `terraform/`):** this builds and pushes the image to ECR, then creates the AgentCore Runtime and the webui web function. A runtime update takes a few minutes (platform V2 prepares a new snapshot), and any change under `doom/` triggers a new image and runtime version.

```sh
make deploy   # npm ci + terraform init/apply
```

See the `webui_url` output, open it and press **Let's play DOOM**.

To run the web UI locally against the deployed runtime (requests are signed with your local AWS credentials):

```sh
make webui-run-acr   # http://localhost:3000
```

Once done playing, destroy the resources. 

```sh
make destroy  # removes everything again
```

**Controls:** WASD move and turn · K fire · L open/use · Shift run · Alt+A/D strafe · 1-7 weapons · Tab map · Esc menu (use the arrows and Enter in menus).

## Limits worth knowing

- AgentCore ends a streamed response after about 100 MB, which is a few minutes of gameplay.
- A session lives at most 5 minutes (intentional limit for this experiment, you can set it up to 8 hours). It ends 2 minutes after the last stream closes (`terraform/ac_runtime_doom.tf`). After that, the tab's next request starts a new game.
- Frames are 320×200 WebP sent as base64 SSE: about 35 fps and 7–8 Mbit/s while moving, almost nothing on static screens.
- Logs: the webui writes to `/aws/lambda/web/agentcore-doom-webui`, the runtime to `/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT`.

## Credits

- [doomgeneric](https://github.com/ozkl/doomgeneric) by ozkl, derived from id Software's Doom source and Chocolate Doom: GPL-2.0-or-later.
- [Freedoom](https://freedoom.github.io/) game data and music: BSD-3-Clause.
- FluidR3 GM soundfont by Frank Wen: MIT. The music is rendered with it at image build time, using [FluidSynth](https://www.fluidsynth.org/) and [LAME](https://lame.sourceforge.io/); those tools and the soundfont stay in a build stage and are not in the image.
- [sharp](https://sharp.pixelplumbing.com/) (Apache-2.0) with its prebuilt [libvips](https://www.libvips.org/) (LGPL-3.0-or-later), [AWS SDK for JavaScript](https://github.com/aws/aws-sdk-js-v3) and [Smithy](https://github.com/smithy-lang/smithy-typescript) (Apache-2.0).

## License

The code in this repository is MIT-licensed (see [LICENSE](LICENSE)), including the headless platform layer in `doom/engine/`. The repository contains no third-party code or game data: the image build downloads doomgeneric (at the commit pinned in `doom/Dockerfile`) and Freedoom.

The container image combines several licenses:

- The engine binary, `doomgeneric_headless`, is built from doomgeneric together with `doom/engine/`, so as a whole it is GPL-2.0-or-later.
- Freedoom's `freedoom1.wad` is BSD-3-Clause; its license is included in the image as `/game/COPYING.txt`.
- The music MP3s are rendered from Freedoom's music (BSD-3-Clause) with samples from the FluidR3 GM soundfont (MIT).
- sharp's libvips is LGPL-3.0-or-later; Node.js and the Debian base image come with their own open-source licenses.

The image is built and run in your own AWS account. If you redistribute the image or the engine binary, the GPL requires you to offer the corresponding source: `doom/engine/` plus doomgeneric at the pinned commit.

DOOM is a trademark of its owner. Freedoom is independent free content and contains no data from the original game. AWS, Amazon Bedrock AgentCore, AWS Lambda and their logos are trademarks of Amazon.com, Inc. or its affiliates. This project is not affiliated with or endorsed by id Software, ZeniMax Media, Microsoft or Amazon Web Services.
