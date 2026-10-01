# LegacyAI API. Small, non-root, no secrets baked in (all configuration comes from the
# environment at run time). Build from the services/api directory:
#   docker build -t legacyai-api services/api

FROM node:24.21.0-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:24.21.0-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24.21.0-trixie-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json openapi.yaml ./
# The image ships its own non-root user ("node", uid 1000).
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
