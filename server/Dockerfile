# Ship List v2 Phase 6 -- the server has always run on the host
# (`pnpm --filter server dev`) with no image at all; docker-compose.yml
# carried a comment noting a broken `server` service (`build: ./server`
# with no Dockerfile behind it) was removed rather than fixed. This is
# that Dockerfile.
#
# @tappay/shared has no build step -- its package.json "main" points
# directly at TS source (./src/index.ts), resolved at runtime by tsx the
# same way `pnpm --filter server dev` already does. Adding a real `tsc`
# build for the server alone would still leave shared unbuilt, so the
# runtime stage below runs the server the same way dev does (tsx, no
# --watch) rather than introducing a half-solution compiled-server/
# uncompiled-shared split. This is a deliberate choice for a demo-stage
# app with no existing build pipeline, not an oversight -- revisit if/when
# @tappay/shared ever gets a real build step of its own.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.15.1 --activate
WORKDIR /app

# ---- deps: install only what @tappay/server needs (itself + @tappay/shared) ----
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY server/package.json server/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY mobile/package.json mobile/package.json
# pnpm needs every workspace package.json present to resolve the lockfile
# even when filtering -- mobile's package.json is read but its (heavy,
# native-toolchain-dependent) deps are never installed by this filter.
RUN pnpm install --frozen-lockfile --filter "@tappay/server..."

# ---- runtime ----
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY packages/shared packages/shared
COPY server server

WORKDIR /app/server
EXPOSE 3000

# Config is read directly from process.env (server/src/config.ts) -- no
# .env file is baked into or expected inside the image; the orchestrator
# (docker-compose's `environment:`, or a real deploy's secret manager)
# supplies every value listed in .env.example at container start.

# node's built-in fetch avoids adding curl/wget to the alpine base just
# for this. /health/live (not /ready) matches what this check is actually
# for -- "is the process alive," not "is it ready for traffic," which
# /health/ready already exists to answer separately for a load balancer.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://localhost:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Alpine's node images already run as a non-root `node` user's home is
# writable, but the process itself defaults to root unless told otherwise --
# this project's own rule (CLAUDE.md's "fail closed" ethos) applies here too.
USER node

CMD ["npx", "tsx", "src/index.ts"]
