# One image: the Bun web app, ffmpeg, and whisper.cpp with its model baked in.
# Transcription runs in-process on the box's CPU; nothing calls a hosted model.

# ------------------------------------------------------------- whisper.cpp --
# Built once here, statically, so the running container never compiles and the
# binary does not depend on an OpenMP runtime the slim base may not carry.
FROM debian:bookworm-slim AS whisper
RUN apt-get update \
 && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp /opt/whisper.cpp \
 && cmake -S /opt/whisper.cpp -B /opt/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF -DGGML_OPENMP=OFF \
 && cmake --build /opt/whisper.cpp/build --config Release -j "$(nproc)" --target whisper-cli \
 && install -Dm755 /opt/whisper.cpp/build/bin/whisper-cli /out/whisper-cli
# The multilingual model, not base.en: people send interviews in every language,
# and an English-only model turns Spanish into confident English nonsense.
# WHISPER_MODEL_NAME=small trades about 3x the CPU for noticeably better text.
ARG WHISPER_MODEL_NAME=base
RUN sh /opt/whisper.cpp/models/download-ggml-model.sh "$WHISPER_MODEL_NAME" \
 && install -Dm644 "/opt/whisper.cpp/models/ggml-$WHISPER_MODEL_NAME.bin" "/out/ggml-$WHISPER_MODEL_NAME.bin"

# ----------------------------------------------------------------- JS deps --
FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app
COPY package.json bun.lock* bunfig.toml ./
COPY apps/web/package.json apps/web/
COPY packages/auth/package.json packages/auth/
COPY packages/cli/package.json packages/cli/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/mcp/package.json packages/mcp/
COPY packages/notify/package.json packages/notify/
COPY packages/payments/package.json packages/payments/
COPY packages/transcribe/package.json packages/transcribe/
RUN bun install --frozen-lockfile || bun install

# ----------------------------------------------------------------- runtime --
FROM oven/bun:1.3.14-slim AS runtime
ARG WHISPER_MODEL_NAME=base
ENV NODE_ENV=production \
    XDG_DATA_HOME=/app/.data \
    WHISPER_MODEL=/app/.data/media2markdown/models/ggml-${WHISPER_MODEL_NAME}.bin \
    DATA_DIR=/data
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# media2markdown-core looks for tools in $XDG_DATA_HOME/media2markdown/bin first
# and for models in $XDG_DATA_HOME/media2markdown/models.
COPY --from=whisper /out/whisper-cli /app/.data/media2markdown/bin/whisper-cli
COPY --from=whisper /out/ggml-${WHISPER_MODEL_NAME}.bin /app/.data/media2markdown/models/
RUN ln -s /usr/bin/ffmpeg /app/.data/media2markdown/bin/ffmpeg \
 && ln -s /usr/bin/ffprobe /app/.data/media2markdown/bin/ffprobe \
 && mkdir -p /data && chown bun:bun /data
# Bun's isolated linker keeps each workspace's dependencies in its own
# node_modules, so the whole install is copied, not just the root.
COPY --from=deps /app /app
COPY . .
# The build context keeps the checkout's own permissions, and a box with umask 007
# leaves everything unreadable to the unprivileged user below.
RUN chmod -R a+rX /app
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "apps/web/src/main.js"]
