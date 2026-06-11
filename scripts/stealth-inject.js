#!/usr/bin/env node
/**
 * Stealth injector: connects to an already-running Chrome via CDP WebSocket
 * and registers a Page.addScriptToEvaluateOnNewDocument payload that patches
 * all fingerprint vectors checked by PerimeterX / Datadome / Cloudflare before
 * any page JavaScript runs.
 *
 * Run once after Chrome is ready:
 *   node stealth-inject.js [http://localhost:9222]
 */

import {createRequire} from 'module';
import http from 'http';

const require = createRequire(import.meta.url);

let WebSocket;
try {
  ({WebSocket} = require('ws'));
} catch {
  WebSocket = null;
}

const CHROME_URL = process.argv[2] || 'http://localhost:9222';

// ─── Stealth script injected on every new document ────────────────────────────
// Patches the most-checked fingerprint vectors used by PerimeterX bot detection.
const STEALTH_SCRIPT = `
(function () {
  // 1. Remove navigator.webdriver entirely
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
    delete navigator.__proto__.webdriver;
  } catch (_) {}

  // 2. Restore window.chrome runtime object (absent in headless/CDP Chrome)
  if (!window.chrome) {
    window.chrome = {
      app: {isInstalled: false, InstallState: {DISABLED:'disabled',INSTALLED:'installed',NOT_INSTALLED:'not_installed'}, RunningState: {CANNOT_RUN:'cannot_run',READY_TO_RUN:'ready_to_run',RUNNING:'running'}},
      runtime: {
        PlatformOs: {MAC:'mac',WIN:'win',ANDROID:'android',CROS:'cros',LINUX:'linux',OPENBSD:'openbsd'},
        PlatformArch: {ARM:'arm',X86_32:'x86-32',X86_64:'x86-64'},
        PlatformNaclArch: {ARM:'arm',X86_32:'x86-32',X86_64:'x86-64'},
        RequestUpdateCheckStatus: {THROTTLED:'throttled',NO_UPDATE:'no_update',UPDATE_AVAILABLE:'update_available'},
        OnInstalledReason: {INSTALL:'install',UPDATE:'update',CHROME_UPDATE:'chrome_update',SHARED_MODULE_UPDATE:'shared_module_update'},
        OnRestartRequiredReason: {APP_UPDATE:'app_update',OS_UPDATE:'os_update',PERIODIC:'periodic'},
        connect: function(){},
        sendMessage: function(){},
      },
      csi: function(){return {startE:Date.now(),onloadT:Date.now(),pageT:Math.random()*5000+1000,tran:15};},
      loadTimes: function(){return {commitLoadTime:Date.now()/1000,connectionInfo:'h2',finishDocumentLoadTime:0,finishLoadTime:0,firstPaintAfterLoadTime:0,firstPaintTime:0,navigationType:'Other',npnNegotiatedProtocol:'h2',requestTime:Date.now()/1000,startLoadTime:Date.now()/1000,wasAlternateProtocolAvailable:false,wasFetchedViaSpdy:true,wasNpnNegotiated:true};},
    };
  }

  // 3. Spoof WebGL renderer to look like a real Intel GPU (not Mesa/llvmpipe)
  const getParameterProxyHandler = {
    apply(target, ctx, args) {
      const param = args[0];
      // UNMASKED_RENDERER_WEBGL = 37446, UNMASKED_VENDOR_WEBGL = 37445
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      if (param === 37445) return 'Intel Inc.';
      return Reflect.apply(target, ctx, args);
    },
  };
  try {
    const proto = WebGLRenderingContext.prototype;
    proto.getParameter = new Proxy(proto.getParameter, getParameterProxyHandler);
    const proto2 = WebGL2RenderingContext.prototype;
    proto2.getParameter = new Proxy(proto2.getParameter, getParameterProxyHandler);
  } catch (_) {}

  // 4. Realistic navigator.plugins (empty array is a bot signal)
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          {name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format'},
          {name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: ''},
          {name: 'Native Client', filename: 'internal-nacl-plugin', description: ''},
        ];
        plugins.refresh = () => {};
        plugins.item = i => plugins[i] || null;
        plugins.namedItem = n => plugins.find(p => p.name === n) || null;
        Object.setPrototypeOf(plugins, PluginArray.prototype);
        return plugins;
      },
      configurable: true,
    });
  } catch (_) {}

  // 5. Realistic language settings
  try {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true,
    });
  } catch (_) {}

  // 6. navigator.permissions.query — return "prompt" for geolocation/notifications
  //    (headless Chrome returns "denied" which is a bot signal)
  try {
    const origQuery = window.navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.__proto__.query = async function(params) {
      if (['geolocation', 'notifications', 'push', 'midi'].includes(params.name)) {
        return {state: 'prompt', onchange: null};
      }
      return origQuery(params);
    };
  } catch (_) {}

  // 7. Consistent hardwareConcurrency (bots often report 2)
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => 8, configurable: true});
  } catch (_) {}

  // 8. deviceMemory (missing in automated Chrome)
  try {
    Object.defineProperty(navigator, 'deviceMemory', {get: () => 8, configurable: true});
  } catch (_) {}
})();
`;

// ─── CDP helpers ──────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

// Get the WebSocket URL of the first PAGE target (not browser-level).
// Page.addScriptToEvaluateOnNewDocument is a Page-domain method and must be
// called on a page/tab target, not the browser-level devtools/browser endpoint.
async function getPageWsUrl() {
  const targets = await get(`${CHROME_URL}/json/list`);
  if (Array.isArray(targets)) {
    const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) return page.webSocketDebuggerUrl;
  }
  // Fallback: open a new blank target then get its WS URL
  await get(`${CHROME_URL}/json/new`);
  const targets2 = await get(`${CHROME_URL}/json/list`);
  if (Array.isArray(targets2)) {
    const page = targets2.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) return page.webSocketDebuggerUrl;
  }
  throw new Error('No page target WebSocket URL found');
}

async function injectStealth(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 1;

    ws.on('open', () => {
      // Register stealth script to run before any page JS on every navigation.
      // Must be called on a page-level target (devtools/page/...).
      ws.send(JSON.stringify({
        id: id++,
        method: 'Page.addScriptToEvaluateOnNewDocument',
        params: {source: STEALTH_SCRIPT, runImmediately: false},
      }));
    });

    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && msg.result !== undefined) {
        console.log('[stealth-inject] registered stealth script, id:', msg.result.identifier);
        ws.close();
        resolve();
      } else if (msg.error) {
        ws.close();
        reject(new Error(JSON.stringify(msg.error)));
      }
    });

    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 10000);
  });
}

// ─── Proxy auth handler ────────────────────────────────────────────────────────
// If CHROME_PROXY_USER + CHROME_PROXY_PASS are set, register a CDP listener that
// automatically responds to proxy 407 auth challenges so Chrome never prompts the
// user. Uses the browser-level target (not page-level) because Fetch events for
// proxy auth arrive on the browser target.
async function setupProxyAuth(browserWsUrl) {
  const proxyUser = process.env.CHROME_PROXY_USER;
  const proxyPass = process.env.CHROME_PROXY_PASS;
  if (!proxyUser || !proxyPass) return;

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(browserWsUrl);
    let id = 1;
    const send = obj => ws.send(JSON.stringify({...obj, id: id++}));

    ws.on('open', () => {
      // Enable Fetch with proxy auth interception at browser level
      send({method: 'Fetch.enable', params: {handleAuthRequests: true, patterns: [{urlPattern: '*'}]}});
    });

    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      // Handle proxy auth challenge
      if (msg.method === 'Fetch.authRequired') {
        const {requestId, authChallenge} = msg.params;
        if (authChallenge && authChallenge.source === 'Proxy') {
          send({
            method: 'Fetch.continueWithAuth',
            params: {
              requestId,
              authChallengeResponse: {
                response: 'ProvideCredentials',
                username: proxyUser,
                password: proxyPass,
              },
            },
          });
        } else {
          send({method: 'Fetch.continueWithAuth', params: {requestId, authChallengeResponse: {response: 'Default'}}});
        }
      }
      // Pass through all other intercepted requests
      if (msg.method === 'Fetch.requestPaused') {
        send({method: 'Fetch.continueRequest', params: {requestId: msg.params.requestId}});
      }
      // Resolve once Fetch.enable is confirmed
      if (msg.id === 1 && msg.result !== undefined) {
        console.log('[stealth-inject] proxy auth handler registered');
        resolve();
      }
    });

    ws.on('error', reject);
    setTimeout(() => resolve(), 5000); // non-fatal timeout
  });
}

async function main() {
  if (!WebSocket) {
    // ws not available — skip silently (will degrade gracefully)
    console.warn('[stealth-inject] ws module not found, skipping stealth injection');
    process.exit(0);
  }

  console.log('[stealth-inject] connecting to', CHROME_URL);
  const wsUrl = await getPageWsUrl();
  console.log('[stealth-inject] ws:', wsUrl);
  await injectStealth(wsUrl);
  console.log('[stealth-inject] stealth patches registered for all future pages');

  // Set up proxy auth on the browser-level WebSocket target if credentials provided
  if (process.env.CHROME_PROXY_USER) {
    const browserInfo = await new Promise((resolve, reject) => {
      http.get(`${CHROME_URL}/json/version`, res => {
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });
    await setupProxyAuth(browserInfo.webSocketDebuggerUrl);
    console.log('[stealth-inject] proxy auth active for', process.env.CHROME_PROXY_USER);
  }
}

main().catch(err => {
  console.error('[stealth-inject] error:', err.message);
  // Non-fatal: Chrome should still work without stealth patches
  process.exit(0);
});
