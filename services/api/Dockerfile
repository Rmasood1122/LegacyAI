# LegacyAI API, with the built web application inside it. Small, non-root, no secrets baked in (all
# configuration comes from the environment at run time).
#
# Build from the REPOSITORY ROOT, because the image needs two folders (services/api and web):
#   docker build -f services/api/Dockerfile -t legacyai-api .
# What may enter the build is listed in services/api/Dockerfile.dockerignore (everything else is left out).

FROM node:24.21.0-trixie-slim AS build
WORKDIR /app
COPY services/api/package.json services/api/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY services/api/tsconfig.json services/api/tsconfig.build.json ./
COPY services/api/src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:24.21.0-trixie-slim AS deps
WORKDIR /app
COPY services/api/package.json services/api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# The screens: plain files built once, here. The build itself checks that they fit the strict browser
# policy the API sends with them (web/scripts/check-build.mjs) and fails the image build otherwise.
FROM node:24.21.0-trixie-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/index.html web/vite.config.ts web/tsconfig.json ./
COPY web/public ./public
COPY web/scripts ./scripts
COPY web/src ./src
RUN npm run build

FROM node:24.21.0-trixie-slim
ENV NODE_ENV=production
# Where the API finds the screens. Not a secret. The API reads these files once at start-up and
# refuses to start if the folder is missing or holds a file type it does not serve.
ENV WEB_DIST_DIR=/app/web
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=web --chown=node:node /web/dist ./web
COPY --chown=node:node services/api/package.json services/api/openapi.yaml ./
# The image ships its own non-root user ("node", uid 1000).
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
