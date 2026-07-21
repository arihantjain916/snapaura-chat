# ---------- BUILD STAGE ----------
FROM node:20-alpine AS builder

# Essential for Prisma/Alpine compatibility
RUN apk add --no-cache libc6-compat

WORKDIR /app

RUN npm install -g pnpm

# 1. Copy ONLY the dependency files first
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma/

# 2. Install EVERYTHING (including the Prisma CLI)
RUN pnpm install --frozen-lockfile

# 3. Copy the rest of the source (.dockerignore keeps local node_modules out)
COPY . .

# 4. Generate and build
RUN pnpm prisma generate
RUN pnpm build

# ---------- PRODUCTION STAGE ----------
FROM node:20-alpine AS runner

RUN apk add --no-cache libc6-compat

WORKDIR /app
ENV NODE_ENV=production

# Copy the built app and the modules holding the generated Prisma client.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma

# Drop root; the base image ships an unprivileged "node" user.
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tsup emits ESM as dist/index.mjs. package.json's "start" script pointed at
# dist/index.js, which does not exist.
CMD ["node", "dist/index.mjs"]
