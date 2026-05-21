# europa-node — self-contained build.
#
# `docker build -t europa-node .` from the repo root works without
# any pre-build step. Two stages:
#   1. builder — installs deps (incl. native better-sqlite3 against
#      the image's libc), esbuild-bundles the daemon into dist/.
#   2. runtime — minimal image with wireguard-tools/iproute2/iptables
#      and just the bundled dist + node_modules/better-sqlite3.

FROM node:20-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.0.6 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN pnpm build

# Re-install only better-sqlite3 with --foreground-scripts so the
# native .node binary is present + visible. esbuild marks it external,
# so the runtime needs the actual node_modules entry.
RUN npm install --omit=dev --no-package-lock --foreground-scripts better-sqlite3@11.5.0


FROM node:20-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends wireguard-tools iproute2 iptables \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY package.json ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Runs as root: `wg set` requires NET_ADMIN, and most Linux distros
# enforce that via root-owned netlink sockets. Limit blast radius at
# the orchestrator level (see k8/deployment.yml securityContext +
# docker-compose's cap_add).
CMD ["node", "dist/index.cjs"]
