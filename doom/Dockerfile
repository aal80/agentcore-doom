# Doom agent image for Bedrock AgentCore Runtime (ARM64).
# Build: docker build --platform linux/arm64 -t agentcore-doom doom/

ARG DOOMGENERIC_COMMIT=e257a09527062bfb986b6e5e0780839b6cbd5b71
ARG FREEDOOM_VERSION=0.13.0
ARG FREEDOOM_SHA256=3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59

# Game data: Freedoom (BSD-3-Clause).
FROM debian:bookworm-slim AS wad
ARG FREEDOOM_VERSION
ARG FREEDOOM_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSL -o freedoom.zip https://github.com/freedoom/freedoom/releases/download/v${FREEDOOM_VERSION}/freedoom-${FREEDOOM_VERSION}.zip \
 && echo "${FREEDOOM_SHA256}  freedoom.zip" | sha256sum -c - \
 && unzip -j freedoom.zip "freedoom-${FREEDOOM_VERSION}/freedoom1.wad" "freedoom-${FREEDOOM_VERSION}/COPYING.txt" -d /src/wad

# Engine: headless doomgeneric.
FROM debian:bookworm-slim AS engine
ARG DOOMGENERIC_COMMIT
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init doomgeneric \
 && git -C doomgeneric fetch --depth 1 https://github.com/ozkl/doomgeneric.git ${DOOMGENERIC_COMMIT} \
 && git -C doomgeneric checkout FETCH_HEAD
COPY engine/ /src/engine/
RUN make -C /src/engine DG_SRC=/src/doomgeneric/doomgeneric -j"$(nproc)"

# Music: MIDI lumps pre-rendered to MP3. The synth and the 142 MB soundfont stay in this stage.
FROM node:24-bookworm-slim AS music
RUN apt-get update \
 && apt-get install -y --no-install-recommends fluidsynth fluid-soundfont-gm lame \
 && rm -rf /var/lib/apt/lists/*
COPY --from=wad /src/wad/freedoom1.wad /src/
COPY agent/wad.js /src/agent/
COPY music/render.mjs /src/music/
RUN node /src/music/render.mjs /src/freedoom1.wad /usr/share/sounds/sf2/FluidR3_GM.sf2 /music

FROM node:24-bookworm-slim
WORKDIR /game
COPY --from=engine /src/engine/doomgeneric_headless /game/
COPY --from=wad /src/wad/ /game/
COPY --from=music /music/ /game/music/
# Agent dependencies (sharp: WebP frame encoding, prebuilt libvips for linux-arm64) before the source, so code
# changes don't reinstall them.
COPY agent/package.json agent/package-lock.json /game/agent/
RUN cd /game/agent && npm ci --omit=dev
COPY agent/ /game/agent/
USER node
EXPOSE 8080
CMD ["node", "/game/agent/server.js"]
