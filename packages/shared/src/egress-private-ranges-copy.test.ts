import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  EGRESS_LAN_BLOCKING_NEEDS_BWRAP,
  EGRESS_PRIVATE_RANGES_HELP,
} from './egress-private-ranges-copy';

describe('egress private-range UI copy', () => {
  it('states that private ranges are blocked unless listed explicitly', () => {
    assert.match(EGRESS_PRIVATE_RANGES_HELP, /Private ranges are blocked unless listed explicitly/);
    assert.match(EGRESS_PRIVATE_RANGES_HELP, /exact IP/);
    assert.match(EGRESS_PRIVATE_RANGES_HELP, /Wildcards/);
    assert.match(EGRESS_PRIVATE_RANGES_HELP, /169\.254\.0\.0\/16/);
    assert.match(EGRESS_PRIVATE_RANGES_HELP, /fd00:ec2::254/);
    assert.match(EGRESS_PRIVATE_RANGES_HELP, /100\.100\.100\.200/);
    assert.match(EGRESS_PRIVATE_RANGES_HELP, /metadata\.google\.internal/);
  });

  it('warns that LAN blocking needs bwrap', () => {
    assert.match(EGRESS_LAN_BLOCKING_NEEDS_BWRAP, /isolation=bwrap/);
    assert.match(EGRESS_LAN_BLOCKING_NEEDS_BWRAP, /none/);
    assert.match(EGRESS_LAN_BLOCKING_NEEDS_BWRAP, /seatbelt/);
  });
});
