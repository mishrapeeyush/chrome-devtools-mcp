#!/usr/bin/env node
/**
 * Start local goose-http + interactive live view, open a URL, keep running.
 *
 * Usage:
 *   npm run build
 *   BRIGHTDATA_AUTH='...' node scripts/run-local-live-view.mjs
 *
 * Env:
 *   GOOSE_NAV_URL=https://www.skyscanner.net/
 *   GOOSE_LIVE_PORT=6087
 *   GOOSE_TEST_PORT=8766
 *   GOOSE_NAV_TIMEOUT=120000
 *   BRIGHTDATA_COUNTRY=us
 */
import {spawn} from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {parseBrightDataAuth} from './brightdata-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MCP_PORT = Number(process.env.GOOSE_TEST_PORT ?? 8766);
const LIVE_PORT = Number(process.env.GOOSE_LIVE_PORT ?? 6087);
const HOST = process.env.GOOSE_TEST_HOST ?? '127.0.0.1';
const NAV_URL = process.env.GOOSE_NAV_URL ?? 'https://www.skyscanner.net/';
const NAV_TIMEOUT = Number(process.env.GOOSE_NAV_TIMEOUT ?? 120_000);

function waitForPort(port, timeoutMs = 90_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.request({host: HOST, port, path: '/', method: 'GET'}, res => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      req.on('error', retry);
      req.end();
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`port ${port} not ready`));
        return;
      }
      setTimeout(tick, 400);
    };
    tick();
  });
}

function spawnGooseServer() {
  if (!parseBrightDataAuth()) {
    throw new Error('Set BRIGHTDATA_AUTH');
  }
  return spawn(
    process.execPath,
    [path.join(ROOT, 'scripts/goose-http-entrypoint.mjs')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(MCP_PORT),
        HOST,
        ENABLE_SCREENCAST: '1',
        SCREENCAST_PORT: String(LIVE_PORT),
        CHROME_MCP_BIN: path.join(ROOT, 'build/src/bin/chrome-devtools-mcp.js'),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
}

async function main() {
  console.error(`[live-view] starting MCP on :${MCP_PORT}, live view on :${LIVE_PORT}`);
  const proc = spawnGooseServer();
  const shutdown = () => {
    if (!proc.killed) {
      proc.kill('SIGTERM');
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await waitForPort(MCP_PORT);

  const client = new Client(
    {name: 'local-live-view', version: '1.0.0'},
    {capabilities: {}},
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${HOST}:${MCP_PORT}/mcp?redis_channel=local_live_view`),
  );
  await client.connect(transport, {timeout: 120_000});

  console.error(`[live-view] opening ${NAV_URL} (timeout ${NAV_TIMEOUT}ms)…`);
  const result = await client.callTool({
    name: 'new_page',
    arguments: {url: NAV_URL, timeout: NAV_TIMEOUT},
  });

  await waitForPort(LIVE_PORT, 30_000);

  const liveUrl = `http://${HOST}:${LIVE_PORT}/`;
  if (result.isError) {
    console.error('[live-view] navigation warning:', result.content?.[0]?.text ?? result);
    console.error(`[live-view] live view still up — open ${liveUrl} and click to interact (accept cookies, etc.)`);
  } else {
    console.error(`[live-view] ready — open ${liveUrl}`);
    console.error('[live-view] click/type in the canvas to control the browser (crosshair cursor)');
  }

  console.log(
    JSON.stringify({liveViewUrl: liveUrl, navUrl: NAV_URL, mcpPort: MCP_PORT}, null, 2),
  );

  await new Promise(() => {});
}

main().catch(err => {
  console.error('[live-view] fatal:', err.message);
  process.exit(1);
});
