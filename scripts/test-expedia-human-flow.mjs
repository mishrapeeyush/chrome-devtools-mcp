#!/usr/bin/env node
/**
 * Expedia DataDome human-flow test — intent-based detection mitigations.
 *
 * Gap 1: Human mouse trajectory to search button (not element.click())
 * Gap 2: Pre-click fidget on form fields (10-30s)
 * Gap 3: Wait for datadome cookie before search (not just _abck)
 *
 * Usage:
 *   BRIGHTDATA_AUTH='...' BRIGHTDATA_COUNTRY=us \
 *     node scripts/test-expedia-human-flow.mjs
 */
import puppeteer from 'puppeteer-core';
import {buildBrightDataWsEndpoint, parseBrightDataAuth} from './brightdata-config.mjs';

const DWELL_MS = Number(process.env.EXPEDIA_DWELL_MS ?? 12_000);
const FIDGET_MS = Number(process.env.EXPEDIA_FIDGET_MS ?? 15_000);
const GOOGLE_QUERY = process.env.EXPEDIA_GOOGLE_QUERY ?? 'expedia hotels dubai';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

async function humanMouseMove(page, startX, startY, endX, endY, durationMs) {
  const steps = Math.max(20, Math.round(durationMs / 16));
  const delay = durationMs / steps;
  for (let i = 1; i <= steps; i++) {
    const t = easeInOutCubic(i / steps);
    const jitter = Math.sin(i * 0.8) * 1.5 * (1 - Math.abs(t - 0.5) * 2);
    const nx = startX + (endX - startX) * t + (Math.random() - 0.5) * 2;
    const ny =
      startY + (endY - startY) * t + jitter + (Math.random() - 0.5) * 1.5;
    await page.mouse.move(nx, ny);
    await sleep(delay);
  }
}

async function humanClickElement(page, element, durationMs = 1400) {
  const box = await element.boundingBox();
  if (!box) {
    return false;
  }
  const tx = Math.round(box.x + box.width * (0.35 + Math.random() * 0.3));
  const ty = Math.round(box.y + box.height * (0.35 + Math.random() * 0.3));
  const angle = Math.random() * Math.PI * 2;
  const dist = 90 + Math.random() * 80;
  const sx = Math.round(tx + Math.cos(angle) * dist);
  const sy = Math.round(ty + Math.sin(angle) * dist);
  await humanMouseMove(page, sx, sy, tx, ty, durationMs);
  await sleep(200 + Math.random() * 300);
  await page.mouse.click(tx, ty);
  return true;
}

async function humanHoverElement(page, element, durationMs = 700) {
  const box = await element.boundingBox();
  if (!box) {
    return false;
  }
  const tx = Math.round(box.x + box.width * 0.5);
  const ty = Math.round(box.y + box.height * 0.5);
  const sx = tx - 60 + Math.round(Math.random() * 40);
  const sy = ty + 20 + Math.round(Math.random() * 30);
  await humanMouseMove(page, sx, sy, tx, ty, durationMs);
  await sleep(500 + Math.random() * 600);
  return true;
}

function isBlocked(url, title, text) {
  const lower = text.toLowerCase();
  return (
    title.includes('Bot or Not') ||
    lower.includes('show us your human side') ||
    url.includes('captcha-delivery.com')
  );
}

async function cookieState(page) {
  return page.evaluate(() => {
    const raw = document.cookie;
    return {
      hasDatadome: raw.includes('datadome'),
      hasAbck: raw.includes('_abck'),
      url: location.href,
      title: document.title,
    };
  });
}

async function waitForDatadome(page, maxMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const state = await cookieState(page);
    if (state.hasDatadome) {
      return state;
    }
    await sleep(2000);
  }
  return cookieState(page);
}

async function main() {
  if (!parseBrightDataAuth()) {
    throw new Error('Set BRIGHTDATA_AUTH or BRIGHTDATA_USER+BRIGHTDATA_PASS');
  }

  const wsEndpoint = buildBrightDataWsEndpoint();
  const capturedApi = [];

  const browser = await puppeteer.connect({browserWSEndpoint: wsEndpoint});
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(120_000);

  page.on('response', async response => {
    const url = response.url();
    const type = response.request().resourceType();
    if (type !== 'xhr' && type !== 'fetch') {
      return;
    }
    if (!/graphql|Hotel-Search|lodging|searchResults|eg-external|api\.expedia/i.test(url)) {
      return;
    }
    try {
      const body = await response.text();
      capturedApi.push({
        url: url.slice(0, 180),
        status: response.status(),
        bytes: body.length,
      });
    } catch {
      // body unavailable after navigation
    }
  });

  const log = [];

  log.push('step:google_entry');
  await page.goto('https://www.google.com/', {waitUntil: 'domcontentloaded'});
  await sleep(3000);
  await page.goto(
    `https://www.google.com/search?q=${encodeURIComponent(GOOGLE_QUERY)}`,
    {waitUntil: 'domcontentloaded'},
  );
  await sleep(2000);

  const organicHref = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="expedia.com"]')];
    const organic = links.find(
      a =>
        !a.href.includes('google.com') &&
        !a.href.includes('aclk') &&
        /Travel-Guide-Hotels|expedia\.com/i.test(a.href),
    );
    return organic?.href ?? null;
  });

  if (organicHref) {
    await page.evaluate(href => {
      const link = [...document.querySelectorAll('a')].find(a => a.href === href);
      if (link) {
        link.click();
      }
    }, organicHref);
    await page.waitForNavigation({waitUntil: 'domcontentloaded', timeout: 60_000}).catch(() => {});
  } else {
    log.push('warn:no_organic_link');
  }
  await sleep(2000);
  log.push({after_organic: await cookieState(page).catch(() => ({error: 'context_lost'}))});

  log.push(`step:dwell_${DWELL_MS}ms`);
  await page.evaluate(() => window.scrollBy({top: 350, behavior: 'smooth'}));
  await sleep(DWELL_MS);

  log.push('step:wait_datadome_cookie');
  const cookieAfterWait = await waitForDatadome(page);
  log.push({cookies: cookieAfterWait});

  if (!cookieAfterWait.hasDatadome) {
    log.push('warn:datadome_missing_extra_dwell');
    await sleep(8000);
    log.push({cookies_retry: await cookieState(page)});
  }

  log.push(`step:fidget_${FIDGET_MS}ms`);
  const fidgetStart = Date.now();

  let fidgetTargets = [];
  try {
    fidgetTargets = await page.evaluate(() => {
    const out = [];
    const buttons = [...document.querySelectorAll('button, [role="button"], input')];
    for (const el of buttons) {
      const label = (
        el.getAttribute('aria-label') ??
        el.getAttribute('placeholder') ??
        el.textContent ??
        ''
      ).trim();
      if (/date|traveler|guest|check.?in/i.test(label)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          out.push({label: label.slice(0, 60), x: r.x, y: r.y, w: r.width, h: r.height});
        }
      }
    }
    return out.slice(0, 4);
  });
  } catch (err) {
    log.push({fidget_error: String(err)});
  }

  for (const target of fidgetTargets) {
    if (Date.now() - fidgetStart > FIDGET_MS) {
      break;
    }
    const tx = Math.round(target.x + target.w * 0.5);
    const ty = Math.round(target.y + target.h * 0.5);
    await humanMouseMove(
      page,
      tx - 70 + Math.random() * 40,
      ty + 25,
      tx,
      ty,
      650,
    );
    await sleep(600 + Math.random() * 500);
    log.push({fidget_hover: target.label});
  }

  const dateOpened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b =>
      /date|check.?in/i.test(
        (b.getAttribute('aria-label') ?? b.textContent ?? '').trim(),
      ),
    );
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  if (dateOpened && Date.now() - fidgetStart < FIDGET_MS) {
    await sleep(1200);
    await page.keyboard.press('Escape');
    log.push({fidget: 'calendar_peek'});
  }

  log.push('step:human_click_search');
  const searchBtn = await page.evaluateHandle(() => {
    const buttons = [...document.querySelectorAll('button')];
    return (
      buttons.find(b => /^search$/i.test((b.textContent ?? '').trim())) ??
      buttons.find(b => /check prices|search/i.test(b.textContent ?? '')) ??
      null
    );
  });
  const searchEl = searchBtn.asElement();
  let clickedSearch = false;
  if (searchEl) {
    clickedSearch = await humanClickElement(page, searchEl, 1600);
  }
  log.push({clickedSearch});

  if (clickedSearch) {
    await page.waitForNavigation({waitUntil: 'domcontentloaded', timeout: 60_000}).catch(() => {});
    await sleep(6000);
  }

  const finalText = await page.evaluate(() => document.body?.innerText ?? '');
  const finalState = await cookieState(page);
  const blocked = isBlocked(finalState.url, finalState.title, finalText);

  console.log(
    JSON.stringify(
      {
        verdict: blocked ? 'BLOCKED_AT_SEARCH' : 'ACCESSIBLE',
        blocked,
        hasDatadomeBeforeSearch: cookieAfterWait.hasDatadome,
        xhrCaptureCount: capturedApi.length,
        capturedApi: capturedApi.slice(0, 8),
        finalUrl: finalState.url,
        finalTitle: finalState.title,
        log,
        textSample: finalText.slice(0, 400),
      },
      null,
      2,
    ),
  );

  await browser.close();
  process.exit(blocked ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
