/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {
  gaussianSmooth1d,
  generateHumanPathPoints,
  morphDistribution,
  randomWalk,
} from '../../src/utils/humanMouse.js';

describe('humanMouse', () => {
  it('randomWalk produces cumulative steps', () => {
    const walk = randomWalk(20, 5);
    assert.strictEqual(walk.length, 20);
    assert.notStrictEqual(walk[19], walk[0]);
  });

  it('gaussianSmooth1d preserves length', () => {
    const data = randomWalk(50, 8);
    const smoothed = gaussianSmooth1d(data, 2);
    assert.strictEqual(smoothed.length, data.length);
  });

  it('morphDistribution adjusts mean toward target', () => {
    const data = randomWalk(100, 20);
    const morphed = morphDistribution(data, 5, 2);
    let sum = 0;
    for (const v of morphed) {
      sum += v;
    }
    const mean = sum / morphed.length;
    assert.ok(Math.abs(mean - 5) < 2);
  });

  it('generateHumanPathPoints ends near target', () => {
    const points = generateHumanPathPoints(10, 20, 400, 300, 40);
    const last = points[points.length - 1];
    assert.ok(Math.abs(last.x - 400) < 30);
    assert.ok(Math.abs(last.y - 300) < 30);
  });
});
