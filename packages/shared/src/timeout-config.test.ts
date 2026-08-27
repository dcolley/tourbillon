import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseHeartbeatTimeoutSec, validateTimeoutConfig } from './timeout-config';

describe('parseHeartbeatTimeoutSec', () => {
  it('returns default when input is null or undefined', () => {
    assert.equal(parseHeartbeatTimeoutSec(null), 300);
    assert.equal(parseHeartbeatTimeoutSec(undefined), 300);
    assert.equal(parseHeartbeatTimeoutSec(null, 500), 500);
  });

  it('returns default when input is empty string', () => {
    assert.equal(parseHeartbeatTimeoutSec(''), 300);
    assert.equal(parseHeartbeatTimeoutSec('', 500), 500);
  });

  it('parses valid numeric string', () => {
    assert.equal(parseHeartbeatTimeoutSec('120'), 120);
    assert.equal(parseHeartbeatTimeoutSec('500'), 500);
  });

  it('parses valid number', () => {
    assert.equal(parseHeartbeatTimeoutSec(120), 120);
    assert.equal(parseHeartbeatTimeoutSec(500), 500);
  });

  it('enforces minimum of 60 seconds', () => {
    assert.equal(parseHeartbeatTimeoutSec('30'), 60);
    assert.equal(parseHeartbeatTimeoutSec(0), 60);
    assert.equal(parseHeartbeatTimeoutSec(-10), 60);
    assert.equal(parseHeartbeatTimeoutSec('59'), 60);
  });

  it('floors decimal values', () => {
    assert.equal(parseHeartbeatTimeoutSec(120.9), 120);
    assert.equal(parseHeartbeatTimeoutSec('150.5'), 150);
  });

  it('returns default for non-numeric strings', () => {
    assert.equal(parseHeartbeatTimeoutSec('abc'), 300);
    assert.equal(parseHeartbeatTimeoutSec('12abc'), 300);
  });

  it('returns default for NaN', () => {
    assert.equal(parseHeartbeatTimeoutSec(NaN), 300);
  });

  it('returns default for Infinity', () => {
    assert.equal(parseHeartbeatTimeoutSec(Infinity), 300);
    assert.equal(parseHeartbeatTimeoutSec(-Infinity), 300);
  });

  it('accepts large values', () => {
    assert.equal(parseHeartbeatTimeoutSec(3600), 3600);
    assert.equal(parseHeartbeatTimeoutSec('7200'), 7200);
  });
});

describe('validateTimeoutConfig', () => {
  it('returns null for null or undefined config', () => {
    assert.equal(validateTimeoutConfig(null), null);
    assert.equal(validateTimeoutConfig(undefined), null);
  });

  it('returns null when heartbeatSec is not set', () => {
    assert.equal(validateTimeoutConfig({ graceSec: 30 }), null);
    assert.equal(validateTimeoutConfig({}), null);
  });

  it('returns null for valid timeout', () => {
    assert.equal(validateTimeoutConfig({ heartbeatSec: 60, graceSec: 30 }), null);
    assert.equal(validateTimeoutConfig({ heartbeatSec: 300, graceSec: 30 }), null);
    assert.equal(validateTimeoutConfig({ heartbeatSec: 600, graceSec: 30 }), null);
  });

  it('rejects non-integer timeout', () => {
    const error = validateTimeoutConfig({ heartbeatSec: 120.5, graceSec: 30 });
    assert.ok(error?.includes('integer'));
  });

  it('rejects timeout below minimum', () => {
    const error = validateTimeoutConfig({ heartbeatSec: 30, graceSec: 30 });
    assert.ok(error?.includes('60'));
  });

  it('rejects zero timeout', () => {
    const error = validateTimeoutConfig({ heartbeatSec: 0, graceSec: 30 });
    assert.ok(error?.includes('60'));
  });

  it('rejects negative timeout', () => {
    const error = validateTimeoutConfig({ heartbeatSec: -10, graceSec: 30 });
    assert.ok(error?.includes('60'));
  });
});
