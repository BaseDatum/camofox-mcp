# ---- Stage 1: Build ----
FROM node:22-alpine AS builder
WORKDIR /app

# Copy shared-bao-auth package from named build context and build it.
# Local: docker build --build-context shared-bao-auth=../../packages/shared-bao-auth-ts .
# CI:   --build-context shared-bao-auth=<path to packages/shared-bao-auth-ts>
COPY --from=shared-bao-auth / /packages/shared-bao-auth-ts
RUN cd /packages/shared-bao-auth-ts && npm install && npm run build

# Copy package.json (lockfile excluded — regenerated because file: dependency
# on shared-bao-auth resolves differently inside Docker via --build-context).
COPY package.json ./

# Install ALL dependencies (including devDeps for tsc).
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# Build TypeScript
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# ---- Stage 2: Runtime ----
FROM node:22-alpine

# Install tini for proper signal handling
RUN apk add --no-cache tini

# Create non-root user
RUN addgroup -S camofox && adduser -S camofox -G camofox

WORKDIR /app

# Copy only production artifacts
COPY --from=builder --chown=camofox:camofox /app/dist ./dist
COPY --from=builder --chown=camofox:camofox /app/node_modules ./node_modules
COPY --from=builder --chown=camofox:camofox /app/package.json ./
# shared-bao-auth symlink in node_modules points to this path
COPY --from=builder --chown=camofox:camofox /packages/shared-bao-auth-ts /packages/shared-bao-auth-ts

# Ensure the non-root user can write under /app if future features need it
RUN chown -R camofox:camofox /app

# Switch to non-root
USER camofox

# Environment defaults
ENV NODE_ENV=production
ENV CAMOFOX_URL=http://localhost:9377
ENV CAMOFOX_TRANSPORT=stdio
ENV CAMOFOX_HTTP_PORT=8080

# HTTP transport listens on CAMOFOX_HTTP_PORT when enabled
EXPOSE 8080

# Use tini as entrypoint for signal forwarding
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
