# Ferroshare relay, published as asgerveng/ferroshare-relay on Docker Hub.
#   docker run -d --restart unless-stopped -p 7777:7777 asgerveng/ferroshare-relay
#
# Build it yourself:
#   docker build -t ferroshare-relay .
#
# Publish (amd64 + arm64):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t asgerveng/ferroshare-relay:latest -t asgerveng/ferroshare-relay:0.1.0 --push .

# The build stage always runs natively and cross-compiles for the target, so
# multi-arch builds need no QEMU emulation and stay fast.
FROM --platform=$BUILDPLATFORM rust:1-bookworm AS build
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) echo x86_64-unknown-linux-gnu  > /triple; pkgs="gcc-x86-64-linux-gnu libc6-dev-amd64-cross" ;; \
      arm64) echo aarch64-unknown-linux-gnu > /triple; pkgs="gcc-aarch64-linux-gnu libc6-dev-arm64-cross" ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && apt-get update && apt-get install -y --no-install-recommends $pkgs && rm -rf /var/lib/apt/lists/* \
    && rustup target add "$(cat /triple)"
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc \
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release --locked -p mls-relay --target "$(cat /triple)" \
    && cp "target/$(cat /triple)/release/mls-relay" /mls-relay

# Small runtime image: just glibc and certificates, no shell, runs as a non-root user.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /mls-relay /usr/local/bin/mls-relay
ENV MLS_LISTEN=0.0.0.0:7777
EXPOSE 7777
ENTRYPOINT ["/usr/local/bin/mls-relay"]
