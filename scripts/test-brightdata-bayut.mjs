#!/usr/bin/env node
/**
 * Bright Data Browser API — Bayut hCaptcha probe
 *
 * Usage:
 *   BRIGHTDATA_AUTH='brd-customer-XXX-zone-YYY:ZONE_PASSWORD' \
 *     node scripts/test-brightdata-bayut.mjs
 *
 * Optional:
 *   TARGET_URL=https://www.bayut.com/
 *   BRIGHTDATA_COUNTRY=ae   # appends -country-ae to username if not already present
 *
 * The REST API key (UUID) is NOT enough — you need Browser API zone username + password
 * from Bright Data Control Panel → Proxies & Scraping → Browser API → Overview.
 */
import puppeteer from 'puppeteer-core';

const {
  BRIGHTDATA_AUTH,
  TARGET_URL = 'https://www.bayut.com/',
  BRIGHTDATA_COUNTRY,
} = process.env;

function buildAuth(rawAuth, country) {
  if (!country) {
    return rawAuth;
  }
  const [user, pass] = rawAuth.split(':');
  if (!user || !pass) {
    throw new Error('BRIGHTDATA_AUTH must be username:password');
  }
  if (user.includes(`country-${country}`)) {
    return rawAuth;
  }
  return `${user}-country-${country}:${pass}`;
}

function classifyBayut(url, title) {
  const path = new URL(url).pathname.toLowerCase();
  const lowerTitle = title.toLowerCase();
  if (path.includes('captchachallenge') || path.includes('/captcha')) {
    return 'BLOCKED_CAPTCHA';
  }
  if (lowerTitle.includes('bayut')) {
    return 'ACCESSIBLE';
  }
  return 'UNKNOWN';
}

async function main() {
  if (!BRIGHTDATA_AUTH) {
    console.error(
      'Set BRIGHTDATA_AUTH=brd-customer-XXX-zone-YYY:ZONE_PASSWORD (from zone Overview tab).',
    );
    console.error(
      'The REST API UUID alone does not work for Browser API (wss://...@brd.superproxy.io:9222).',
    );
    process.exit(1);
  }

  const auth = buildAuth(BRIGHTDATA_AUTH, BRIGHTDATA_COUNTRY);
  const endpoint = `wss://${auth}@brd.superproxy.io:9222`;

  console.log('[bd-bayut] Connecting to Bright Data Browser API...');
  const browser = await puppeteer.connect({browserWSEndpoint: endpoint});
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(120_000);

    console.log(`[bd-bayut] Navigating to ${TARGET_URL}`);
    const response = await page.goto(TARGET_URL, {waitUntil: 'domcontentloaded'});
    const status = response ? response.status() : 0;
    const url = page.url();
    const title = await page.title();
    const html = await page.content();
    const onCaptchaPath = url.toLowerCase().includes('captchachallenge');

    const verdict = classifyBayut(url, title);
    console.log('');
    console.log('=== Bayut probe result ===');
    console.log(`HTTP status : ${status}`);
    console.log(`Final URL   : ${url}`);
    console.log(`Title       : ${title}`);
    console.log(`HTML bytes  : ${html.length}`);
    console.log(`Verdict     : ${verdict}`);
    console.log('');

    if (onCaptchaPath || verdict === 'BLOCKED_CAPTCHA') {
      console.log(
        'Redirected to captchaChallenge — try Page.inspect for manual solve or warmed cookies.',
      );
    } else if (verdict === 'ACCESSIBLE') {
      console.log('Bayut loaded — Browser API bypass works for this target.');
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[bd-bayut] Failed:', message);
  if (message.includes('403')) {
    console.error('403 = wrong username/password or zone is not Browser API type.');
  }
  if (message.includes('407')) {
    console.error('407 = wrong port; Browser API uses wss://...:9222');
  }
  process.exit(1);
});
