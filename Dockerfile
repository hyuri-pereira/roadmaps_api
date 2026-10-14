# syntax=docker/dockerfile:1.7

# =========================================================
# BASE
# =========================================================
FROM node:24-bookworm-slim AS base

WORKDIR /app

ENV TZ=America/Sao_Paulo
ENV DEBIAN_FRONTEND=noninteractive

# Driver "pure" (node-firebird) fala TCP direto com o Firebird, sem fbclient,
# então só o tzdata é necessário.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      tzdata && \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && \
    echo $TZ > /etc/timezone


# =========================================================
# DEPENDENCIAS DE BUILD
# =========================================================
FROM base AS deps

COPY package.json package-lock.json ./

# --ignore-scripts: o node-firebird-driver-native (opcional) não é compilado;
# o @node-rs/argon2 usa o pacote pré-compilado da plataforma.
RUN --mount=type=cache,target=/root/.npm \
    npm ci \
      --ignore-scripts \
      --prefer-offline \
      --no-audit \
      --no-fund


# =========================================================
# BUILD
# =========================================================
FROM deps AS builder

COPY . .

# dist/         -> API (nest build)
# dist-scripts/ -> scripts/preparar-banco.ts usado pelo entrypoint
RUN npm run build && npx tsc -p tsconfig.scripts.json


# =========================================================
# DEPENDENCIAS DE PRODUCAO
# =========================================================
FROM base AS production-deps

COPY package.json package-lock.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci \
      --omit=dev \
      --ignore-scripts \
      --prefer-offline \
      --no-audit \
      --no-fund


# =========================================================
# PRODUCAO / RUNTIME
# =========================================================
FROM base AS production

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=America/Sao_Paulo
ENV PORT=3000
ENV API_PREFIX=api

# Configuração só de runtime (não entra na imagem), passada pelo compose:
# FIREBIRD_*, ENCRYPTION_KEY, JWT_*, GOOGLE_*, ASANA_*, MAIL_*, WAHA_*,
# APP_PUBLIC_URL, FRONTEND_URL, CORS_ORIGINS, BOOTSTRAP_ADMIN_*.


# =========================================================
# USUARIO NAO ROOT
# =========================================================

RUN groupadd \
      --system \
      --gid 1001 \
      nodejs \
    && useradd \
      --system \
      --uid 1001 \
      --gid nodejs \
      --home-dir /app \
      --shell /usr/sbin/nologin \
      nestjs


# =========================================================
# NODE MODULES
# =========================================================

COPY --from=production-deps \
    --chown=nestjs:nodejs \
    /app/node_modules \
    ./node_modules


# =========================================================
# APLICACAO COMPILADA
# =========================================================

COPY --from=builder \
    --chown=nestjs:nodejs \
    /app/dist \
    ./dist

COPY --from=builder \
    --chown=nestjs:nodejs \
    /app/dist-scripts \
    ./dist-scripts


# =========================================================
# SCHEMA E MIGRACOES DO FIREBIRD
# =========================================================

# preparar-banco.js cria o banco / aplica migrações pendentes a cada start.
COPY --chown=nestjs:nodejs \
    db/schema.sql \
    ./db/schema.sql

COPY --chown=nestjs:nodejs \
    db/migracoes \
    ./db/migracoes


# =========================================================
# PACKAGE METADATA / ENTRYPOINT
# =========================================================

COPY --chown=nestjs:nodejs \
    package.json \
    ./package.json

COPY --chown=nestjs:nodejs \
    docker-entrypoint.sh \
    ./docker-entrypoint.sh

RUN sed -i 's/\r$//' docker-entrypoint.sh \
    && chmod +x docker-entrypoint.sh


# =========================================================
# DIRETORIOS GRAVAVEIS
# =========================================================

# Arquivos de referência dos cards (volume no compose).
RUN mkdir -p /app/storage/referencias \
    && chown -R nestjs:nodejs /app/storage


# =========================================================
# EXECUCAO
# =========================================================

USER nestjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/'+(process.env.API_PREFIX||'api')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
