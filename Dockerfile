# ── Multi-stage monorepo build ──────────────────────────────────────────────
# Builds frontend and backend together, serves everything from one container.
# Context: project root (docker build -f Dockerfile .)

# ── Stage 1: Build shared packages and frontend ─────────────────────────────
FROM node:22-slim AS frontend-build
WORKDIR /app
# Copy root tsconfig files (frontend extends ../tsconfig.base.json)
COPY tsconfig.json tsconfig.base.json ./
# Copy and build shared packages first (they are file: dependencies)
COPY shared/ shared/
RUN cd shared/api-client-react && npm install && npm run build 2>/dev/null || true
# Copy frontend source
COPY frontend/package.json frontend/
RUN cd frontend && npm install
COPY frontend/ frontend/
RUN cd frontend && npm run build

# ── Stage 2: Build backend ──────────────────────────────────────────────────
FROM node:22-slim AS backend-build
WORKDIR /app
# Copy root tsconfig files (backend extends ../tsconfig.base.json)
COPY tsconfig.json tsconfig.base.json ./
# Copy and build shared packages first
COPY shared/ shared/
RUN cd shared/api-zod && npm install 2>/dev/null || true
# Build backend
COPY backend/package.json backend/
RUN cd backend && npm install
COPY backend/ backend/
RUN cd backend && node ./build.mjs

# ── Stage 3: Production runtime ─────────────────────────────────────────────
FROM node:22-slim AS runtime
# git is needed for the migration agent's git diff / baseline snapshot
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Backend runtime files
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=backend-build /app/backend/package.json ./
COPY --from=backend-build /app/backend/node_modules ./node_modules
# Shared packages needed at runtime (api-zod is used by health endpoint)
COPY --from=backend-build /app/shared/api-zod ./shared/api-zod
# Frontend static build (served by backend in production)
COPY --from=frontend-build /app/frontend/dist/public ./frontend/dist/public

ENV NODE_ENV=production
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8000/api/healthz').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
