import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentTokenConfigError,
  CHAT_TOKEN_TTL_SEC,
  RUN_TOKEN_GRACE_SEC,
  RUN_TOKEN_MAX_TTL_SEC,
  mintChatToken,
  mintRunToken,
  runTokenTtlSec,
  verifyAgentTokenSignature,
} from './agent-token';

const SECRET = 'shared-agent-token-secret-110-0123456789';
const env = process.env as Record<string, string | undefined>;
const RUN = { runId: 'r1', agentId: 'a1', companyId: 'c1' };

describe('#110 agent-token (shared)', () => {
  beforeEach(() => {
    env.TOURBILLON_AGENT_TOKEN_SECRET = SECRET;
  });

  it('run token round-trips with exp and is signed', () => {
    const t = mintRunToken(RUN, 600);
    assert.match(t, /^pm_run_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const c = verifyAgentTokenSignature(t);
    assert.equal(c?.kind, 'run');
    assert.equal(c && c.kind === 'run' ? c.runId : null, 'r1');
    assert.ok(c && c.exp - c.iat === 600);
  });

  it('chat token round-trips with the default short TTL', () => {
    const c = verifyAgentTokenSignature(mintChatToken({ chatSessionId: 'chat-a1', agentId: 'a1', companyId: 'c1' }));
    assert.equal(c?.kind, 'chat');
    assert.ok(c && c.exp - c.iat === CHAT_TOKEN_TTL_SEC);
  });

  it('legacy unsigned token is rejected', () => {
    const legacy = `pm_run_${Buffer.from(JSON.stringify({ ...RUN, iat: Date.now() })).toString('base64url')}`;
    assert.equal(verifyAgentTokenSignature(legacy), null);
  });

  it('tampered payload, tampered signature, prefix swap and wrong secret are rejected', () => {
    const t = mintRunToken(RUN, 600);
    const dot = t.lastIndexOf('.');
    const payload = JSON.parse(Buffer.from(t.slice(7, dot), 'base64url').toString());
    const forgedBody = `pm_run_${Buffer.from(JSON.stringify({ ...payload, companyId: 'c2' })).toString('base64url')}`;
    assert.equal(verifyAgentTokenSignature(`${forgedBody}${t.slice(dot)}`), null);
    assert.equal(verifyAgentTokenSignature(`${t.slice(0, dot + 1)}AAAA${t.slice(dot + 5)}`), null);
    assert.equal(verifyAgentTokenSignature(t.replace('pm_run_', 'pm_chat_')), null);
    env.TOURBILLON_AGENT_TOKEN_SECRET = 'a-different-secret-that-is-long-enough!!';
    assert.equal(verifyAgentTokenSignature(t), null);
  });

  it('expired token is rejected', async () => {
    const t = mintRunToken(RUN, 1);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(verifyAgentTokenSignature(t), null);
  });

  it('no secret (or too short): mint throws, verify fails closed', () => {
    const t = mintRunToken(RUN, 600);
    delete env.TOURBILLON_AGENT_TOKEN_SECRET;
    assert.throws(() => mintRunToken(RUN, 600), AgentTokenConfigError);
    assert.equal(verifyAgentTokenSignature(t), null);
    env.TOURBILLON_AGENT_TOKEN_SECRET = 'short';
    assert.throws(() => mintChatToken({ chatSessionId: 'x', agentId: 'a', companyId: 'c' }), AgentTokenConfigError);
  });

  it('run TTL = timeout + grace, capped; no timeout → cap', () => {
    assert.equal(runTokenTtlSec(300), 300 + RUN_TOKEN_GRACE_SEC);
    assert.equal(runTokenTtlSec(0), RUN_TOKEN_MAX_TTL_SEC);
    assert.equal(runTokenTtlSec(undefined), RUN_TOKEN_MAX_TTL_SEC);
    assert.equal(runTokenTtlSec(10 * RUN_TOKEN_MAX_TTL_SEC), RUN_TOKEN_MAX_TTL_SEC);
  });
});
