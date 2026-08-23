# Build context: apps/ingest/ (via Railway rootDirectory)
#
# The self-contained source build, used by a local `alchemy deploy` when
# dist/maple-ingest is absent; CI always takes Dockerfile.prebuilt instead. The
# ECS tasks are ARM64, so this compiles for linux/arm64 — native on an Apple
# Silicon machine, emulated (slowly, but correctly) anywhere else.
FROM rust:1.94-bookworm AS build
WORKDIR /app

COPY . .
RUN cargo build --release

# ---
FROM debian:bookworm-slim AS runner

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=build /app/target/release/maple-ingest /usr/local/bin/maple-ingest

EXPOSE 3474

CMD ["maple-ingest"]
