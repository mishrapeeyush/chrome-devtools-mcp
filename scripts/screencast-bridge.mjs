/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Interactive live-view bridge based on CDP Page.startScreencast — the same
// technique Browserbase uses for its live view. Replaces the heavyweight
// x11vnc -> websockify -> noVNC chain: instead of encoding the whole X11
// desktop framebuffer, Chrome's compositor emits JPEG frames of just the page
// viewport, only when it meaningfully changes. Frames are pushed to the browser
// over a WebSocket and drawn onto a <canvas>; mouse/keyboard input from the
// viewer is forwarded back to the page via the CDP Input domain so a human can
// take over (login / OTP / CAPTCHA / payment).
//
// Serves on PORT (default 6080):
//   - any HTTP GET            -> the live.html viewer page
//   - any WebSocket upgrade   -> the frame stream + input channel
// Both work behind an arbitrary ingress path prefix (e.g.
// /instances/<pod>/novnc/) because the viewer uses relative URLs and the
// server accepts the WS upgrade on any path.

import {createServer} from 'node:http';

import puppeteer from 'puppeteer-core';
import {WebSocketServer} from 'ws';

const PORT = Number(
  process.env.SCREENCAST_PORT ?? process.env.NOVNC_PORT ?? 6080,
);
const BROWSER_URL = process.env.CHROME_BROWSER_URL ?? 'http://localhost:9222';
const BROWSER_WS = process.env.CHROME_WS_ENDPOINT?.trim() ?? '';
const JPEG_QUALITY = Number(process.env.SCREENCAST_QUALITY ?? 60);
const MAX_WIDTH = Number(process.env.SCREENCAST_MAX_WIDTH ?? 1280);
const MAX_HEIGHT = Number(process.env.SCREENCAST_MAX_HEIGHT ?? 800);

const LIVE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Live browser</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0b; overflow: hidden; }
  #wrap { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
  #view { max-width: 100%; max-height: 100%; image-rendering: auto; outline: none; cursor: crosshair; background: #000; }
  #status { position: fixed; top: 8px; left: 8px; font: 12px/1.4 system-ui, sans-serif; color: #ddd; background: rgba(0,0,0,.5); padding: 4px 8px; border-radius: 6px; pointer-events: none; }
</style>
</head>
<body>
<div id="wrap"><canvas id="view" tabindex="0"></canvas></div>
<div id="status">connecting…</div>
<script>
(() => {
  const canvas = document.getElementById('view');
  const ctx = canvas.getContext('2d', {alpha: false});
  const status = document.getElementById('status');
  // Intrinsic page size in CSS px, learned from frame metadata. Used to map
  // viewer-normalised input coordinates back to page coordinates.
  let pageW = ${MAX_WIDTH}, pageH = ${MAX_HEIGHT};

  const base = location.pathname.replace(/[^/]*$/, '');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = proto + '//' + location.host + base + 'ws';
  let ws;
  let lastMove = 0;

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { status.textContent = 'live'; setTimeout(() => status.style.opacity = '0', 1500); };
    ws.onclose = () => { status.style.opacity = '1'; status.textContent = 'reconnecting…'; setTimeout(connect, 1000); };
    ws.onmessage = async (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'meta' && m.width && m.height) {
            pageW = m.width; pageH = m.height;
            if (canvas.width !== pageW || canvas.height !== pageH) {
              canvas.width = pageW; canvas.height = pageH;
            }
          }
        } catch {}
        return;
      }
      const blob = new Blob([ev.data], {type: 'image/jpeg'});
      const bmp = await createImageBitmap(blob);
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width; canvas.height = bmp.height;
        pageW = bmp.width; pageH = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
    };
  }
  connect();

  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function norm(e) {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    return {x: Math.max(0, Math.min(1, x)) * pageW, y: Math.max(0, Math.min(1, y)) * pageH};
  }
  const BTN = {0: 'left', 1: 'middle', 2: 'right'};

  canvas.addEventListener('mousemove', (e) => {
    const now = performance.now();
    if (now - lastMove < 33) return; // ~30fps
    lastMove = now;
    const p = norm(e);
    send({t: 'm', type: 'mouseMoved', x: p.x, y: p.y, button: 'none'});
  });
  canvas.addEventListener('mousedown', (e) => {
    canvas.focus();
    const p = norm(e);
    send({t: 'm', type: 'mousePressed', x: p.x, y: p.y, button: BTN[e.button] ?? 'left', clickCount: 1});
  });
  canvas.addEventListener('mouseup', (e) => {
    const p = norm(e);
    send({t: 'm', type: 'mouseReleased', x: p.x, y: p.y, button: BTN[e.button] ?? 'left', clickCount: 1});
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = norm(e);
    send({t: 'm', type: 'mouseWheel', x: p.x, y: p.y, button: 'none', deltaX: e.deltaX, deltaY: e.deltaY});
  }, {passive: false});

  function keyEvent(type, e) {
    send({t: 'k', type, key: e.key, code: e.code, keyCode: e.keyCode,
          text: type === 'keyDown' && e.key.length === 1 ? e.key : undefined,
          modifiers: (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)});
  }
  canvas.addEventListener('keydown', (e) => { e.preventDefault(); keyEvent('keyDown', e); });
  canvas.addEventListener('keyup', (e) => { e.preventDefault(); keyEvent('keyUp', e); });
})();
</script>
</body>
</html>`;

const httpServer = createServer((req, res) => {
  // Serve the viewer for any GET (works under any ingress path, incl. vnc.html).
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(LIVE_HTML);
});

const wss = new WebSocketServer({server: httpServer});
const clients = new Set();

let activeSession = null;
let activePage = null;
let latestMeta = {width: MAX_WIDTH, height: MAX_HEIGHT};
// Cache of the most recent frame so a viewer that connects to an idle page
// (CDP only emits frames on change) sees the current state immediately.
let lastFrame = null;

function broadcastFrame(buffer) {
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(buffer);
    }
  }
}

function broadcastMeta() {
  const msg = JSON.stringify({
    type: 'meta',
    width: latestMeta.width,
    height: latestMeta.height,
  });
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

async function stopActive() {
  const session = activeSession;
  activeSession = null;
  activePage = null;
  if (!session) {
    return;
  }
  try {
    await session.send('Page.stopScreencast');
  } catch {
    // page may already be gone
  }
  try {
    await session.detach();
  } catch {
    // ignore
  }
}

async function streamPage(page) {
  if (activePage === page) {
    return;
  }
  await stopActive();
  let session;
  try {
    session = await page.createCDPSession();
    await session.send('Page.enable');
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: JPEG_QUALITY,
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,
      everyNthFrame: 1,
    });
  } catch (err) {
    console.error('[screencast] failed to start on page:', err?.message ?? err);
    return;
  }
  activeSession = session;
  activePage = page;

  session.on('Page.screencastFrame', async ({data, sessionId, metadata}) => {
    if (metadata?.deviceWidth && metadata?.deviceHeight) {
      const w = Math.round(metadata.deviceWidth);
      const h = Math.round(metadata.deviceHeight);
      if (w !== latestMeta.width || h !== latestMeta.height) {
        latestMeta = {width: w, height: h};
        broadcastMeta();
      }
    }
    lastFrame = Buffer.from(data, 'base64');
    broadcastFrame(lastFrame);
    try {
      await session.send('Page.screencastFrameAck', {sessionId});
    } catch {
      // session may be detaching
    }
  });

  page.once('close', () => {
    if (activePage === page) {
      void pickActivePage();
    }
  });
  console.error('[screencast] streaming', page.url());
}

let browserRef = null;

async function pickActivePage() {
  if (!browserRef) {
    return;
  }
  const pages = await browserRef.pages();
  const visible = pages.filter(p => !p.isClosed());
  if (visible.length === 0) {
    await stopActive();
    return;
  }
  // Prefer the most recently opened non-blank page; fall back to the last one.
  const candidate =
    [...visible].reverse().find(p => p.url() && p.url() !== 'about:blank') ??
    visible[visible.length - 1];
  await streamPage(candidate);
}

function modifiersToButtons(button) {
  switch (button) {
    case 'left':
      return 1;
    case 'right':
      return 2;
    case 'middle':
      return 4;
    default:
      return 0;
  }
}

async function handleInput(msg) {
  const session = activeSession;
  if (!session) {
    return;
  }
  try {
    if (msg.t === 'm') {
      if (msg.type === 'mouseWheel') {
        await session.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: msg.x,
          y: msg.y,
          deltaX: msg.deltaX ?? 0,
          deltaY: msg.deltaY ?? 0,
        });
        return;
      }
      await session.send('Input.dispatchMouseEvent', {
        type: msg.type,
        x: msg.x,
        y: msg.y,
        button: msg.button ?? 'none',
        buttons:
          msg.type === 'mouseReleased' ? 0 : modifiersToButtons(msg.button),
        clickCount: msg.clickCount ?? 0,
      });
    } else if (msg.t === 'k') {
      await session.send('Input.dispatchKeyEvent', {
        type: msg.type,
        key: msg.key,
        code: msg.code,
        windowsVirtualKeyCode: msg.keyCode,
        nativeVirtualKeyCode: msg.keyCode,
        text: msg.text,
        modifiers: msg.modifiers ?? 0,
      });
    }
  } catch (err) {
    console.error('[screencast] input dispatch failed:', err?.message ?? err);
  }
}

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(
    JSON.stringify({
      type: 'meta',
      width: latestMeta.width,
      height: latestMeta.height,
    }),
  );
  if (lastFrame) {
    ws.send(lastFrame);
  }
  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    void handleInput(msg);
  });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

async function connectBrowser() {
  if (BROWSER_WS) {
    return puppeteer.connect({
      browserWSEndpoint: BROWSER_WS,
      defaultViewport: null,
    });
  }
  return puppeteer.connect({
    browserURL: BROWSER_URL,
    defaultViewport: null,
  });
}

async function main() {
  const target = BROWSER_WS || BROWSER_URL;
  // Retry connect until the DevTools endpoint is reachable.
  for (let i = 0; ; i++) {
    try {
      browserRef = await connectBrowser();
      break;
    } catch (err) {
      if (i > 60) {
        console.error(
          '[screencast] could not connect to browser at',
          target,
          err?.message ?? err,
        );
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  browserRef.on('targetcreated', async target => {
    if (target.type() === 'page') {
      try {
        const page = await target.page();
        if (page) {
          await streamPage(page);
        }
      } catch {
        // target may have vanished
      }
    }
  });
  browserRef.on('targetdestroyed', () => {
    void pickActivePage();
  });
  browserRef.on('disconnected', () => {
    console.error('[screencast] browser disconnected; exiting');
    process.exit(1);
  });

  await pickActivePage();

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.error(
      `[screencast] live view on :${PORT} (CDP screencast, interactive)`,
    );
  });
}

void main();
