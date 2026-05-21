# europa-node — self-contained build.
#
# `docker build -t europa-node .` from the repo root works without
# any pre-build step. Two stages:
#   1. builder — installs deps (incl. native better-sqlite3 against
#      the image's libc), esbuild-bundles the daemon into dist/.
#   2. runtime — minimal image with wireguard-tools/iproute2/iptables
#      and the small subtree of node_modules better-sqlite3 needs at
#      runtime. esbuild bundles the rest, so only the native module
#      and its loader deps need to travel.

FROM node:20-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.0.6 --activate

COPY package.json pnpm-lock.yaml ./
# `--config.node-linker=hoisted` produces a flat node_modules tree
# (instead of pnpm's default symlinked .pnpm/ layout). The runtime
# stage below copies the `better-sqlite3` directory plus its
# transitive deps (`bindings`, `file-uri-to-path`) directly out of
# /app/node_modules — that only works if those packages live at the
# top level. Without hoisted, Node throws
# `Cannot find module 'bindings'` at runtime when better-sqlite3
# tries to load its native .node binary.
RUN pnpm install --frozen-lockfile --config.node-linker=hoisted

COPY tsconfig.json ./
COPY src/ ./src/

RUN pnpm build

# Make sure better-sqlite3's native binding compiled cleanly against
# this image's libc. pnpm's install runs the prebuild-install/node-gyp
# step automatically, but `pnpm rebuild` makes any failure load-bearing
# (the build won't finish silently broken).
RUN pnpm rebuild better-sqlite3


FROM node:20-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends wireguard-tools iproute2 iptables \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
# better-sqlite3 calls `require('bindings')` at runtime to locate its
# compiled .node binary; `bindings` in turn `require()`s
# `file-uri-to-path`. All three must be present at /app/node_modules.
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder /app/node_modules/bindings ./node_modules/bindings
COPY --from=builder /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
COPY package.json ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Runs as root: `wg set` requires NET_ADMIN, and most Linux distros
# enforce that via root-owned netlink sockets. Limit blast radius at
# the orchestrator level (see k8/deployment.yml securityContext +
# docker-compose's cap_add).
CMD ["node", "dist/index.cjs"]
