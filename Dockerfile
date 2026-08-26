# daftari serve in a container.
#
# The image bakes in everything the server needs at runtime: the compiled
# dist/, production node_modules (better-sqlite3 and sqlite-vec are native —
# built here, not on the host), git (the version-control layer every write
# commits through), and the default embedding model (local-minilm downloads
# from huggingface.co on first use otherwise — baking it in keeps cold starts
# offline).
#
# The vault is NOT in the image. Mount a persistent volume at /vault holding
# the markdown files and .daftari/config.yaml. The default CMD binds
# 0.0.0.0, which daftari refuses unless the config declares auth AND
# transport_security: external — TLS must terminate upstream (your ingress).
# See docs/deployment.md.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain for native modules when no prebuilt binary matches the platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
# Bake the default embedding model into the image. transformers.js caches
# under node_modules/@huggingface/transformers/.cache/, which the runtime
# stage copies wholesale — first search needs no network egress.
RUN node -e "import('@huggingface/transformers').then(({pipeline}) => pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'))"

FROM node:22-bookworm-slim
# git: required — every vault write auto-commits.
# tini: pid-1 init so signals reach node and zombies are reaped.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git tini \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY templates ./templates
COPY package.json ./
USER node
EXPOSE 8787
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/cli.js", "serve", "--vault", "/vault", "--bind", "0.0.0.0", "--port", "8787"]
