/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {
  defaultBehaviorBaseline,
  parseBehaviorBaseline,
} from '../../src/utils/behaviorBaseline.js';

describe('behaviorBaseline', () => {
  it('parseBehaviorBaseline reads probe payload', () => {
    const baseline = parseBehaviorBaseline({
      meanMoveIntervalMs: 110,
      moveIntervalVariance: 35,
      meanClickPauseMs: 200,
      clickHoldMs: 90,
      postClickPauseMs: 250,
      moveSampleCount: 42,
    });
    assert.ok(baseline);
    assert.strictEqual(baseline.meanMoveIntervalMs, 110);
    assert.strictEqual(baseline.moveSampleCount, 42);
  });

  it('parseBehaviorBaseline rejects error payloads', () => {
    assert.strictEqual(parseBehaviorBaseline({error: 'no probe'}), null);
  });

  it('defaultBehaviorBaseline has sane ranges', () => {
    const baseline = defaultBehaviorBaseline();
    assert.ok(baseline.meanMoveIntervalMs >= 100);
    assert.ok(baseline.meanMoveIntervalMs <= 140);
  });
});
