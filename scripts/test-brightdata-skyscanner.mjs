#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import puppeteer from 'puppeteer-core';

const AUTH = process.env.BRIGHTDATA_AUTH;
if (!AUTH) {
  throw new Error('Set BRIGHTDATA_AUTH');
}

const browser = await puppeteer.connect({
  browserWSEndpoint: `wss://${AUTH}@brd.superproxy.io:9222`,
});
const page = await browser.newPage();
page.setDefaultNavigationTimeout(120_000);

await page.goto('https://www.skyscanner.ae/', {
  waitUntil: 'domcontentloaded',
  timeout: 120_000,
});
await new Promise((r) => setTimeout(r, 4000));

await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('button')];
  const accept = buttons.find((b) =>
    /accept all|accept|agree/i.test(b.textContent ?? ''),
  );
  if (accept) {
    accept.click();
  }
});
await new Promise((r) => setTimeout(r, 2000));

const originSelector =
  'input[aria-label*="From"], input[placeholder*="From"], input[name*="origin"]';
const destSelector =
  'input[aria-label*="To"], input[placeholder*="To"], input[name*="destination"]';

const origin = await page.$(originSelector);
if (origin) {
  await origin.click({clickCount: 3});
  await origin.type('Dubai', {delay: 80});
  await new Promise((r) => setTimeout(r, 2500));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 1500));
}

const dest = await page.$(destSelector);
if (dest) {
  await dest.click({clickCount: 3});
  await dest.type('London', {delay: 80});
  await new Promise((r) => setTimeout(r, 2500));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 1500));
}

const searchHandle = await page.evaluateHandle(() => {
  const buttons = [...document.querySelectorAll('button')];
  return (
    buttons.find(
      (b) =>
        /search/i.test(b.textContent ?? '') &&
        !/search everywhere/i.test(b.textContent ?? ''),
    ) ?? null
  );
});
const searchBtn = searchHandle.asElement();
if (searchBtn) {
  await Promise.all([
    page
      .waitForNavigation({waitUntil: 'domcontentloaded', timeout: 120_000})
      .catch(() => {}),
    searchBtn.click(),
  ]);
}
await new Promise((r) => setTimeout(r, 8000));

const result = await page.evaluate(() => {
  const text = document.body?.innerText ?? '';
  const lower = text.toLowerCase();
  return {
    url: location.href,
    title: document.title,
    blocked:
      lower.includes('captcha') ||
      lower.includes('access denied') ||
      lower.includes('press & hold') ||
      location.href.includes('captcha'),
    hasResults:
      lower.includes('result') ||
      lower.includes('flight') ||
      lower.includes('aed') ||
      !!document.querySelector('[data-testid*="result"], [class*="FlightCard"]'),
    textSample: text.slice(0, 600),
  };
});

console.log(
  JSON.stringify(
    {
      filledOrigin: Boolean(origin),
      filledDest: Boolean(dest),
      clickedSearch: Boolean(searchBtn),
      ...result,
      verdict: result.blocked ? 'BLOCKED' : 'ACCESSIBLE_OR_PARTIAL',
    },
    null,
    2,
  ),
);

await browser.close();
