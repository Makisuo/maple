# Build context: apps/ingest/ (via Railway rootDirectory)
FROM rust:1.88 AS build
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
