/**
 * S313-S4 (Refs #303): ported from vitest to node:test, same pattern as the
 * S303-S2 port of packages/db/src/__tests__/vault-resolution.test.ts. This
 * file imported `describe/it/expect/beforeAll` from 'vitest' while the shared
 * suite runs under `tsx --test`
 * (packages/shared: `tsx --test $(find src -name "*.test.ts" | sort)`); the
 * import failed with "Cannot find module 'vitest'" and the whole file counted
 * as the suite's one baseline failure — meaning NONE of these assertions ever
 * ran. Two consequences, both measured:
 *   - assertions were ported 1:1 except 'should handle nested objects', whose
 *     never-executed per-field assertions contradicted the shipped
 *     substring-matching sanitizer (see the comment there); and
 *   - the two env-mutating tests now restore VAULT_ENCRYPTION_KEY in finally,
 *     so a RED assertion cannot leak the env for the tests that follow.
 *
 * Mutant-recipe note (S319-S3, Refs #319): a mutant that re-adds a vitest import
 * to prove the port must USE the import (e.g. call `expect(...)`) or be a
 * side-effect import (`import 'vitest'`). A plain UNUSED `import { expect }
 * from 'vitest'` SURVIVES — esbuild/tsx drops unused imports before module
 * resolution, so the "Cannot find module 'vitest'" wall never fires and the
 * suite stays green. That is how the #319 gate wrote the mutant, not a weak test.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { encryptCredential, decryptCredential, sanitizeForLogging } from '../vault-encryption';
import type { OAuthTokens } from '../vault-types';

before(() => {
  process.env.VAULT_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

describe('vault-encryption', () => {
  describe('encryptCredential and decryptCredential', () => {
    it('should encrypt and decrypt a simple API key string', () => {
      const apiKey = 'sk-test-1234567890abcdef';
      const encrypted = encryptCredential(apiKey);
      
      assert.ok(encrypted);
      assert.notEqual(encrypted, apiKey);
      assert.equal(typeof encrypted, 'string');
      
      const decrypted = decryptCredential(encrypted);
      assert.equal(decrypted, apiKey);
    });
    
    it('should encrypt and decrypt OAuth tokens', () => {
      const tokens: OAuthTokens = {
        accessToken: 'gho_test123',
        refreshToken: 'ghr_test456',
        expiresAt: Date.now() + 3600000,
        scope: 'repo,user',
      };
      
      const encrypted = encryptCredential(tokens);
      
      assert.ok(encrypted);
      assert.ok(!String(encrypted).includes('gho_test123'));
      
      const decrypted = decryptCredential(encrypted) as OAuthTokens;
      assert.equal(typeof decrypted, 'object');
      assert.equal(decrypted.accessToken, tokens.accessToken);
      assert.equal(decrypted.refreshToken, tokens.refreshToken);
      assert.equal(decrypted.expiresAt, tokens.expiresAt);
      assert.equal(decrypted.scope, tokens.scope);
    });
    
    it('should produce different ciphertext for same input (random IV)', () => {
      const apiKey = 'sk-test-same-input';
      const encrypted1 = encryptCredential(apiKey);
      const encrypted2 = encryptCredential(apiKey);
      
      assert.notEqual(encrypted1, encrypted2);
      
      assert.equal(decryptCredential(encrypted1), apiKey);
      assert.equal(decryptCredential(encrypted2), apiKey);
    });
    
    it('should handle empty string', () => {
      const empty = '';
      const encrypted = encryptCredential(empty);
      const decrypted = decryptCredential(encrypted);
      assert.equal(decrypted, empty);
    });
    
    it('should handle very long API keys', () => {
      const longKey = 'x'.repeat(1000);
      const encrypted = encryptCredential(longKey);
      const decrypted = decryptCredential(encrypted);
      assert.equal(decrypted, longKey);
    });
    
    it('should handle special characters', () => {
      const specialKey = 'sk-test_!@#$%^&*(){}[]|\\:";\'<>?,./~`';
      const encrypted = encryptCredential(specialKey);
      const decrypted = decryptCredential(encrypted);
      assert.equal(decrypted, specialKey);
    });
    
    it('should handle unicode characters', () => {
      const unicodeKey = 'test-日本語-emoji-🔐-key';
      const encrypted = encryptCredential(unicodeKey);
      const decrypted = decryptCredential(encrypted);
      assert.equal(decrypted, unicodeKey);
    });
    
    it('should throw error if VAULT_ENCRYPTION_KEY is not set', () => {
      const originalKey = process.env.VAULT_ENCRYPTION_KEY;
      delete process.env.VAULT_ENCRYPTION_KEY;
      try {
        assert.throws(() => {encryptCredential('test')}, /VAULT_ENCRYPTION_KEY/);
      } finally {
        process.env.VAULT_ENCRYPTION_KEY = originalKey;
      }
    });
    
    it('should throw error if VAULT_ENCRYPTION_KEY is wrong length', () => {
      const originalKey = process.env.VAULT_ENCRYPTION_KEY;
      process.env.VAULT_ENCRYPTION_KEY = 'tooshort';
      try {
        assert.throws(() => {encryptCredential('test')}, /32 bytes/);
      } finally {
        process.env.VAULT_ENCRYPTION_KEY = originalKey;
      }
    });
  });
  
  describe('sanitizeForLogging', () => {
    it('should redact sensitive keys', () => {
      const obj = {
        serverId: 'buffer-mcp',
        value: 'sk-secret-123',
        apiKey: 'test-key',
        accessToken: 'token-123',
        normalField: 'visible',
      };
      
      const sanitized = sanitizeForLogging(obj);
      
      assert.equal(sanitized.serverId, 'buffer-mcp');
      assert.equal(sanitized.normalField, 'visible');
      assert.equal(sanitized.value, '[REDACTED]');
      assert.equal(sanitized.apiKey, '[REDACTED]');
      assert.equal(sanitized.accessToken, '[REDACTED]');
    });
    
    it('should handle nested objects', () => {
      const obj = {
        meta: {
          serverId: 'github-mcp',
          credentials: {
            accessToken: 'secret-token',
            refreshToken: 'secret-refresh',
          },
        },
        publicData: 'visible',
      };
      
      const sanitized = sanitizeForLogging(obj);
      
      assert.equal(sanitized.publicData, 'visible');
      assert.equal(sanitized.meta.serverId, 'github-mcp');
      // S313-S4: this file never RAN under vitest (see header — the import failed
      // as a file-level error), so these two per-field assertions were never
      // exercised and contradict the shipped sanitizer: 'credential' is on the
      // sensitive-keys list and the match is a substring match, so the whole
      // nested `credentials` object is replaced by '[REDACTED]' before its
      // fields are ever visited. Pin the shipped behaviour instead.
      assert.equal(sanitized.meta.credentials, '[REDACTED]');
    });
    
    it('should handle arrays', () => {
      const arr = [
        { id: 1, apiKey: 'key1' },
        { id: 2, apiKey: 'key2' },
      ];
      
      const sanitized = sanitizeForLogging(arr);
      
      assert.equal(sanitized[0].id, 1);
      assert.equal(sanitized[0].apiKey, '[REDACTED]');
      assert.equal(sanitized[1].id, 2);
      assert.equal(sanitized[1].apiKey, '[REDACTED]');
    });
    
    it('should handle case-insensitive matching', () => {
      const obj = {
        ApiKey: 'secret',
        API_KEY: 'secret',
        access_token: 'secret',
        RefreshToken: 'secret',
      };
      
      const sanitized = sanitizeForLogging(obj);
      
      assert.equal(sanitized.ApiKey, '[REDACTED]');
      assert.equal(sanitized.API_KEY, '[REDACTED]');
      assert.equal(sanitized.access_token, '[REDACTED]');
      assert.equal(sanitized.RefreshToken, '[REDACTED]');
    });
    
    it('should not modify primitives', () => {
      assert.equal(sanitizeForLogging('string'), 'string');
      assert.equal(sanitizeForLogging(123), 123);
      assert.equal(sanitizeForLogging(true), true);
      assert.equal(sanitizeForLogging(null), null);
    });
  });
});
