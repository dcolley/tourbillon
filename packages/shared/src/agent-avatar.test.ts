/**
 * AGENT-AVATAR-UI: the avatar config validator — fixed shape/colour sets, lenient id-or-hex
 * colour, and null (default avatar) for anything else, including a broken runtimeConfig.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_AVATAR_PALETTE,
  AGENT_AVATAR_SHAPE_IDS,
  AGENT_AVATAR_SHAPES,
  agentAvatarFromRuntimeConfig,
  parseAgentAvatarConfig,
} from './agent-avatar';

describe('AGENT-AVATAR-UI parseAgentAvatarConfig', () => {
  it('accepts a shape id with a palette id or its exact hex', () => {
    assert.deepEqual(parseAgentAvatarConfig({ shape: 'circle', color: 'blue' }), { shape: 'circle', color: '#3b82f6' });
    assert.deepEqual(parseAgentAvatarConfig({ shape: 'blob-3', color: '#10b981' }), { shape: 'blob-3', color: '#10b981' });
  });

  it('every shape id has a path and every palette colour a lowercase hex', () => {
    for (const id of AGENT_AVATAR_SHAPE_IDS) assert.equal(typeof AGENT_AVATAR_SHAPES[id], 'string');
    assert.equal(Object.keys(AGENT_AVATAR_SHAPES).length, AGENT_AVATAR_SHAPE_IDS.length);
    for (const c of AGENT_AVATAR_PALETTE) assert.match(c.hex, /^#[0-9a-f]{6}$/);
  });

  it('rejects unknown shapes, off-palette colours and non-objects (default avatar)', () => {
    assert.equal(parseAgentAvatarConfig({ shape: 'square', color: 'blue' }), null);
    assert.equal(parseAgentAvatarConfig({ shape: 'circle', color: '#123456' }), null);
    assert.equal(parseAgentAvatarConfig({ shape: 'circle', color: '#3B82F6' }), null); // uppercase hex is not the palette
    assert.equal(parseAgentAvatarConfig({ color: 'blue' }), null);
    assert.equal(parseAgentAvatarConfig(null), null);
    assert.equal(parseAgentAvatarConfig('circle'), null);
    assert.equal(parseAgentAvatarConfig([]), null);
  });

  it('agentAvatarFromRuntimeConfig reads .avatar and survives junk', () => {
    assert.deepEqual(agentAvatarFromRuntimeConfig({ avatar: { shape: 'blob-1', color: 'teal' } }), {
      shape: 'blob-1',
      color: '#14b8a6',
    });
    assert.equal(agentAvatarFromRuntimeConfig({ avatar: 'nope' }), null);
    assert.equal(agentAvatarFromRuntimeConfig({}), null);
    assert.equal(agentAvatarFromRuntimeConfig(null), null);
    assert.equal(agentAvatarFromRuntimeConfig(undefined), null);
    assert.equal(agentAvatarFromRuntimeConfig('runtime'), null);
  });
});
