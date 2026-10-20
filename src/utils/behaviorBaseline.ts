/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Page} from '../third_party/index.js';

import {
  randomApproachStart,
  randomPointInBox,
  randomNormal,
  sleep,
  type HumanMouse,
} from './humanMouse.js';

/** Session rhythm captured on a low-risk page (travel guide dwell). */
export interface BehaviorBaseline {
  meanMoveIntervalMs: number;
  moveIntervalVariance: number;
  meanClickPauseMs: number;
  clickHoldMs: number;
  postClickPauseMs: number;
  moveSampleCount: number;
  capturedAt: number;
}

export interface HumanMouseClickable extends HumanMouse {
  down(): Promise<void>;
  up(): Promise<void>;
}

export function defaultBehaviorBaseline(): BehaviorBaseline {
  return {
    meanMoveIntervalMs: 100 + Math.random() * 40,
    moveIntervalVariance: 20 + Math.random() * 40,
    meanClickPauseMs: 160 + Math.random() * 80,
    clickHoldMs: 85 + Math.random() * 25,
    postClickPauseMs: 220 + Math.random() * 90,
    moveSampleCount: 0,
    capturedAt: Date.now(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

export function parseBehaviorBaseline(value: unknown): BehaviorBaseline | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.error === 'string') {
    return null;
  }
  const meanMoveIntervalMs = readNumber(value.meanMoveIntervalMs);
  const moveIntervalVariance = readNumber(value.moveIntervalVariance);
  const meanClickPauseMs = readNumber(value.meanClickPauseMs);
  const clickHoldMs = readNumber(value.clickHoldMs);
  const postClickPauseMs = readNumber(value.postClickPauseMs);
  const moveSampleCount = readNumber(value.moveSampleCount);
  if (
    meanMoveIntervalMs === undefined ||
    moveIntervalVariance === undefined ||
    meanClickPauseMs === undefined ||
    clickHoldMs === undefined ||
    postClickPauseMs === undefined ||
    moveSampleCount === undefined
  ) {
    return null;
  }
  return {
    meanMoveIntervalMs,
    moveIntervalVariance,
    meanClickPauseMs,
    clickHoldMs,
    postClickPauseMs,
    moveSampleCount,
    capturedAt: Date.now(),
  };
}

const INSTALL_PROBE_SCRIPT = `
(() => {
  const store = { moves: [], clicks: [], installed: Date.now() };
  if (window.__bdBaselineHandlers) {
    document.removeEventListener('mousemove', window.__bdBaselineHandlers.move);
    document.removeEventListener('click', window.__bdBaselineHandlers.click);
  }
  const onMove = () => { store.moves.push(Date.now()); };
  const onClick = () => { store.clicks.push(Date.now()); };
  document.addEventListener('mousemove', onMove, { passive: true });
  document.addEventListener('click', onClick, { passive: true });
  window.__bdBaseline = store;
  window.__bdBaselineHandlers = { move: onMove, click: onClick };
  return { status: 'recording', installed: store.installed };
})()
`;

const READ_PROBE_SCRIPT = `
(() => {
  const store = window.__bdBaseline;
  if (!store) {
    return { error: 'no probe installed' };
  }
  const moves = store.moves || [];
  let meanMoveIntervalMs = 100;
  let moveIntervalVariance = 40;
  if (moves.length > 2) {
    const intervals = [];
    for (let i = 1; i < moves.length; i++) {
      intervals.push(moves[i] - moves[i - 1]);
    }
    meanMoveIntervalMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    moveIntervalVariance = intervals.reduce(
      (s, x) => s + (x - meanMoveIntervalMs) ** 2,
      0,
    ) / intervals.length;
  }
  const clicks = store.clicks || [];
  let meanClickPauseMs = 180;
  if (clicks.length > 1) {
    const pauses = [];
    for (let i = 1; i < clicks.length; i++) {
      pauses.push(clicks[i] - clicks[i - 1]);
    }
    meanClickPauseMs = pauses.reduce((a, b) => a + b, 0) / pauses.length;
  }
  return {
    meanMoveIntervalMs,
    moveIntervalVariance,
    meanClickPauseMs,
    clickHoldMs: 90,
    postClickPauseMs: 250,
    moveSampleCount: moves.length,
  };
})()
`;

export async function installBehaviorBaselineProbe(page: Page): Promise<void> {
  await page.evaluate(INSTALL_PROBE_SCRIPT);
}

export async function readBehaviorBaselineProbe(
  page: Page,
): Promise<BehaviorBaseline | null> {
  const raw = await page.evaluate(READ_PROBE_SCRIPT);
  const parsed = parseBehaviorBaseline(raw);
  if (parsed && parsed.moveSampleCount < 3) {
    const fallback = defaultBehaviorBaseline();
    return {
      ...fallback,
      meanMoveIntervalMs: parsed.meanMoveIntervalMs,
      moveIntervalVariance: parsed.moveIntervalVariance,
      meanClickPauseMs: parsed.meanClickPauseMs,
      moveSampleCount: parsed.moveSampleCount,
    };
  }
  return parsed;
}

function cubicBezier(
  t: number,
  p0: number,
  p1: number,
  p2: number,
  p3: number,
): number {
  const u = 1 - t;
  return (
    u * u * u * p0 +
    3 * u * u * t * p1 +
    3 * u * t * t * p2 +
    t * t * t * p3
  );
}

function normalizedStepDelayMs(
  baseline: BehaviorBaseline,
  progress: number,
): number {
  const std = Math.sqrt(Math.max(baseline.moveIntervalVariance, 1));
  let delay = Math.max(
    10,
    randomNormal(baseline.meanMoveIntervalMs, std),
  );
  const ease = Math.sin(progress * Math.PI);
  delay = delay / (ease + 0.3);
  if (progress > 0.85) {
    delay *= 1.1 + Math.random() * 0.6;
  }
  if (Math.random() < 0.08) {
    delay += 20 + Math.random() * 70;
  }
  return delay;
}

/**
 * Move using a cubic-bezier path with step timing normalized to the session
 * baseline captured on the travel-guide dwell page.
 */
export async function humanMouseMoveWithBaseline(
  mouse: HumanMouse,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  baseline: BehaviorBaseline,
  durationMs: number,
): Promise<void> {
  const steps = 18 + Math.floor(Math.random() * 11);
  const cp1x = startX + (Math.random() - 0.5) * 200;
  const cp1y = startY + (Math.random() - 0.5) * 160;
  const cp2x = endX + (Math.random() - 0.5) * 160;
  const cp2y = endY + (Math.random() - 0.5) * 120;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    let x = cubicBezier(t, startX, cp1x, cp2x, endX);
    let y = cubicBezier(t, startY, cp1y, cp2y, endY);
    if (t > 0.8) {
      x += (Math.random() - 0.5) * 4;
      y += (Math.random() - 0.5) * 4;
    }
    await mouse.move(Math.round(x), Math.round(y));
    const delay = normalizedStepDelayMs(baseline, t);
    const durationScale = Math.max(
      0.5,
      durationMs / (steps * baseline.meanMoveIntervalMs),
    );
    await sleep(delay * durationScale);
  }
}

/** Click with baseline-normalized pre-hover, hold, and post-click pauses. */
export async function humanMouseClickWithBaseline(
  mouse: HumanMouseClickable,
  x: number,
  y: number,
  baseline: BehaviorBaseline,
  preHoverMs?: number,
): Promise<void> {
  const pauseMs =
    preHoverMs ??
    Math.max(
      80,
      Math.round(
        randomNormal(
          baseline.meanClickPauseMs,
          Math.sqrt(baseline.moveIntervalVariance),
        ),
      ),
    );
  await sleep(pauseMs);
  await mouse.move(x, y);
  await mouse.move(x + (Math.random() > 0.5 ? 1 : -1), y);
  await sleep(
    Math.max(
      40,
      Math.round(randomNormal(baseline.meanClickPauseMs * 0.5, 30)),
    ),
  );
  await mouse.down();
  await sleep(
    Math.max(50, Math.round(randomNormal(baseline.clickHoldMs, 15))),
  );
  await mouse.up();
  await sleep(
    Math.max(100, Math.round(randomNormal(baseline.postClickPauseMs, 40))),
  );
}

export function puppeteerMouseClickable(mouse: {
  move(x: number, y: number): Promise<void>;
  down(): Promise<void>;
  up(): Promise<void>;
}): HumanMouseClickable {
  return {
    move: (x, y) => mouse.move(x, y),
    down: () => mouse.down(),
    up: () => mouse.up(),
  };
}

export interface NormalizedClickTarget {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function normalizedHumanClick(
  mouse: HumanMouseClickable,
  box: NormalizedClickTarget,
  baseline: BehaviorBaseline,
  durationMs: number,
  preHoverMs?: number,
): Promise<{x: number; y: number}> {
  const target = randomPointInBox(box.x, box.y, box.width, box.height);
  const start = randomApproachStart(target.x, target.y);
  await humanMouseMoveWithBaseline(
    mouse,
    start.x,
    start.y,
    target.x,
    target.y,
    baseline,
    durationMs,
  );
  await humanMouseClickWithBaseline(
    mouse,
    target.x,
    target.y,
    baseline,
    preHoverMs,
  );
  return target;
}
