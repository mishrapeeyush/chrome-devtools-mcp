#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal Expedia test — mirrors Bright Data Playground pattern:
 *   goto(expedia.com) → dismiss popups → check homepage (no Google warm-up)
 *
 * Usage:
 *   BRIGHTDATA_AUTH='user:pass' BRIGHTDATA_COUNTRY=us \
 *     node scripts/test-expedia-playground.mjs
 */
import puppeteer from 'puppeteer-core';

import {buildBrightDataWsEndpoint, parseBrightDataAuth} from './brightdata-config.mjs';

const SETTLE_MS = Number(process.env.EXPEDIA_SETTLE_MS ?? 3000);
const SUBMIT_SEARCH = /^(1|true|yes)$/i.test(process.env.EXPEDIA_SUBMIT ?? '');
const DESTINATION = process.env.EXPEDIA_DEST ?? 'Dubai';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function dismissPopups(page) {
  const closed = await page.evaluate(() => {
    const selectors = [
      'button[aria-label="Close"]',
      'button[aria-label="Dismiss"]',
      '[data-testid="close-button"]',
      'button.uitk-modal-close',
    ];
    let count = 0;
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el instanceof HTMLElement) {
        el.click();
        count++;
      }
    }
    const buttons = [...document.querySelectorAll('button')];
    const signInClose = buttons.find(
      b =>
        /close|dismiss|no thanks|not now/i.test(b.textContent ?? '') ||
        /close|dismiss/i.test(b.getAttribute('aria-label') ?? ''),
    );
    if (signInClose instanceof HTMLElement) {
      signInClose.click();
      count++;
    }
    return count;
  });
  if (closed > 0) {
    await sleep(500);
  }
  return closed;
}

function isBlocked(url, title, text) {
  const lower = text.toLowerCase();
  return (
    title.includes('Bot or Not') ||
    lower.includes('show us your human side') ||
    url.includes('captcha-delivery.com')
  );
}

async function main() {
  if (!parseBrightDataAuth()) {
    throw new Error('Set BRIGHTDATA_AUTH or BRIGHTDATA_USER+BRIGHTDATA_PASS');
  }

  const wsEndpoint = buildBrightDataWsEndpoint();
  const browser = await puppeteer.connect({browserWSEndpoint: wsEndpoint});
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60_000);

  const log = ['step:goto_homepage'];
  await page.goto('https://www.expedia.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  await sleep(1500);
  const popupsClosed = await dismissPopups(page);
  log.push(`step:popups_closed_${popupsClosed}`);
  await sleep(SETTLE_MS);

  const homepage = await page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    const hasSearch =
      !!document.querySelector(
        'input[placeholder*="Where"], input[aria-label*="Where"], button[type="submit"]',
      ) || /where to\?|search/i.test(text);
    return {
      url: location.href,
      title: document.title,
      hasSearch,
      hasDatadome: document.cookie.includes('datadome'),
      textSample: text.slice(0, 300),
    };
  });

  let searchResult = null;
  if (SUBMIT_SEARCH && homepage.hasSearch && !isBlocked(homepage.url, homepage.title, homepage.textSample)) {
    log.push('step:fill_search');
    const destInput = await page.$(
      'input[placeholder*="Where"], input[aria-label*="Where"]',
    );
    if (destInput) {
      await destInput.click({clickCount: 3});
      await destInput.type(DESTINATION, {delay: 90});
      await sleep(1000);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await sleep(800);
    }

    log.push('step:click_search');
    const searchBtn = await page.$(
      'button[type="submit"], button[data-testid="submit-button"]',
    );
    if (searchBtn) {
      await searchBtn.click();
      await page
        .waitForNavigation({waitUntil: 'domcontentloaded', timeout: 60_000})
        .catch(() => {});
      await sleep(4000);
      try {
        searchResult = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          textSample: (document.body?.innerText ?? '').slice(0, 300),
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        searchResult = {
          url: page.url(),
          title: '(evaluate blocked)',
          textSample: '',
          evaluateError: msg.slice(0, 400),
          bdRobotsTxt: /robots\.txt|brob/i.test(msg),
        };
      }
    }
  }

  const final = searchResult ?? homepage;
  const finalText = final.textSample ?? '';
  const finalTitle = final.title ?? '';
  const blocked = isBlocked(final.url, finalTitle, finalText);

  const bdRestricted = Boolean(
    searchResult &&
      typeof searchResult === 'object' &&
      'bdRobotsTxt' in searchResult &&
      searchResult.bdRobotsTxt,
  );

  console.log(
    JSON.stringify(
      {
        verdict: blocked
          ? 'BLOCKED'
          : bdRestricted
            ? 'SEARCH_NAV_OK_BD_RESTRICTED'
            : 'ACCESSIBLE',
        blocked,
        bdRobotsTxtRestricted: bdRestricted,
        mode: SUBMIT_SEARCH ? 'homepage+search' : 'homepage_only',
        homepage,
        searchResult,
        log,
      },
      null,
      2,
    ),
  );

  await browser.close();
  process.exit(blocked ? 1 : bdRestricted ? 3 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
