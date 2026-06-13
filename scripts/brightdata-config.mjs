#!/usr/bin/env node
/**
 * Bright Data Browser API configuration helper.
 *
 * Env (one of):
 *   BRIGHTDATA_AUTH=brd-customer-XXX-zone-YYY:password
 *   BRIGHTDATA_USER + BRIGHTDATA_PASS
 *
 * Optional:
 *   BRIGHTDATA_COUNTRY=ae
 *   BRIGHTDATA_HOST=brd.superproxy.io
 *   BRIGHTDATA_PORT=9222
 *   BRIGHTDATA_DOMAINS=bayut.com,bankfab.com  (comma-separated, for routing hints)
 *   BRIGHTDATA_FORCE=1  (always use Bright Data when credentials are set)
 */

/** @typedef {{user: string, pass: string}} BrightDataCredentials */

/** @param {NodeJS.ProcessEnv} [env] @returns {BrightDataCredentials | null} */
export function parseBrightDataAuth(env = process.env) {
  const auth = env.BRIGHTDATA_AUTH?.trim();
  if (auth) {
    const colon = auth.indexOf(':');
    if (colon <= 0 || colon === auth.length - 1) {
      throw new Error('BRIGHTDATA_AUTH must be username:password');
    }
    return {user: auth.slice(0, colon), pass: auth.slice(colon + 1)};
  }

  const user = env.BRIGHTDATA_USER?.trim();
  const pass = env.BRIGHTDATA_PASS?.trim();
  if (user && pass) {
    return {user, pass};
  }
  return null;
}

/** @param {string} user @param {string | undefined} country */
export function buildBrightDataUsername(user, country) {
  if (!country) {
    return user;
  }
  const tag = `country-${country}`;
  if (user.includes(tag)) {
    return user;
  }
  return `${user}-${tag}`;
}

/**
 * Domains that benefit from Bright Data Browser API (CAPTCHA / TLS / PerimeterX).
 * Override with BRIGHTDATA_DOMAINS=comma,separated,list
 */
export const BRIGHTDATA_DEFAULT_DOMAINS = [
  'bayut.com',
  'bankfab.com',
  'skyscanner.net',
  'skyscanner.ae',
  'skyscanner.com',
];

/** @param {NodeJS.ProcessEnv} [env] @returns {string[]} */
export function brightDataDomainList(env = process.env) {
  const raw = env.BRIGHTDATA_DOMAINS?.trim();
  if (raw) {
    return raw
      .split(',')
      .map(d => d.trim().toLowerCase())
      .filter(Boolean);
  }
  return BRIGHTDATA_DEFAULT_DOMAINS;
}

/**
 * Whether a target URL should use Bright Data instead of a local Chrome pod.
 * @param {string} url
 * @param {NodeJS.ProcessEnv} [env]
 */
export function shouldUseBrightData(url, env = process.env) {
  if (!parseBrightDataAuth(env)) {
    return false;
  }
  if (/^(1|true|yes)$/i.test(env.BRIGHTDATA_FORCE?.trim() ?? '')) {
    return true;
  }
  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const domain of brightDataDomainList(env)) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, country?: string, host?: string, port?: string }} [options]
 * @returns {string}
 */
export function buildBrightDataWsEndpoint(options = {}) {
  const env = options.env ?? process.env;
  const parsed = parseBrightDataAuth(env);
  if (!parsed) {
    throw new Error(
      'Set BRIGHTDATA_AUTH or BRIGHTDATA_USER + BRIGHTDATA_PASS for Bright Data Browser API',
    );
  }

  const country = options.country ?? env.BRIGHTDATA_COUNTRY?.trim();
  const host = options.host ?? env.BRIGHTDATA_HOST?.trim() ?? 'brd.superproxy.io';
  const port = options.port ?? env.BRIGHTDATA_PORT?.trim() ?? '9222';
  const username = buildBrightDataUsername(parsed.user, country);
  return `wss://${username}:${parsed.pass}@${host}:${port}`;
}

import {fileURLToPath} from 'node:url';
import path from 'node:path';

function isMain() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return (
    path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry)
  );
}

if (isMain()) {
  const args = process.argv.slice(2);
  if (args.includes('--print-endpoint')) {
    console.log(buildBrightDataWsEndpoint());
    process.exit(0);
  }
  if (args.includes('--should-use')) {
    const url = args[args.indexOf('--should-use') + 1] ?? '';
    console.log(shouldUseBrightData(url) ? 'yes' : 'no');
    process.exit(0);
  }
  console.error('Usage: node brightdata-config.mjs --print-endpoint');
  console.error('       node brightdata-config.mjs --should-use <url>');
  process.exit(1);
}
