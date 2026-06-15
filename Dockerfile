# syntax=docker/dockerfile:1
# Bright Data Browser API only — no local Chrome or Xvfb.
# Build (required on Apple Silicon): docker build --platform linux/amd64 -t chrome-devtools-mcp:local .
#
# Goose HTTP (MCP on :8080):
#   docker run --rm -e BRIGHTDATA_AUTH -p 8080:8080 chrome-devtools-mcp:local
#
# Interactive pod (MCP :8090 + live view :6080):
#   docker run --rm -e BRIGHTDATA_AUTH -e PORT=8090 -e ENABLE_SCREENCAST=1 \
#     -p 8090:8090 -p 6080:6080 chrome-devtools-mcp:local

FROM node:24-bookworm AS build

WORKDIR /app

COPY package.json package-lock.json .npmrc ./

ENV PUPPETEER_SKIP_DOWNLOAD=true

RUN npm ci --ignore-scripts

COPY . .

ENV NODE_OPTIONS=--max_old_space_size=4096

RUN node scripts/prepare.ts

RUN npm run bundle

FROM node:24-bookworm AS runtime

WORKDIR /app

COPY package.json package-lock.json .npmrc ./

RUN npm ci --ignore-scripts \
    && npm install mcp-proxy@6.5.1 redis@5.12.1 @modelcontextprotocol/sdk@1.29.0 --no-save \
    && npm cache clean --force

ENV NODE_ENV=production \
    CI=true \
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PORT=8080 \
    HOST=0.0.0.0 \
    ENABLE_SCREENCAST=1

COPY --from=build /app/build ./build
COPY --from=build /app/LICENSE ./LICENSE
COPY scripts/goose-http-entrypoint.mjs /app/scripts/
COPY scripts/brightdata-config.mjs /app/scripts/
COPY scripts/brightdata-entrypoint.sh /app/scripts/
COPY scripts/screencast-bridge.mjs /app/scripts/
COPY scripts/goose-http-entrypoint-xvfb.sh /app/scripts/
RUN chmod +x /app/scripts/brightdata-entrypoint.sh /app/scripts/goose-http-entrypoint-xvfb.sh

EXPOSE 8080 6080 8090

ENTRYPOINT ["/app/scripts/goose-http-entrypoint-xvfb.sh"]
