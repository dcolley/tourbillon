import { describe, it, expect, beforeAll } from 'vitest';
import { encryptCredential, decryptCredential, sanitizeForLogging } from '../vault-encryption';
import type { OAuthTokens } from '@tourbillon/db/schema';

beforeAll(() => {
  process.env.VAULT_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

describe('vault-encryption', () => {
  describe('encryptCredential and decryptCredential', () => {
    it('should encrypt and decrypt a simple API key string', () => {
      const apiKey = 'sk-test-1234567890abcdef';
      const encrypted = encryptCredential(apiKey);
      
      expect(encrypted).toBeTruthy();
      expect(encrypted).not.toBe(apiKey);
      expect(typeof encrypted).toBe('string');
      
      const decrypted = decryptCredential(encrypted);
      expect(decrypted).toBe(apiKey);
    });
    
    it('should encrypt and decrypt OAuth tokens', () => {
      const tokens: OAuthTokens = {
        accessToken: 'gho_test123',
        refreshToken: 'ghr_test456',
        expiresAt: Date.now() + 3600000,
        scope: 'repo,user',
      };
      
      const encrypted = encryptCredential(tokens);
      
      expect(encrypted).toBeTruthy();
      expect(encrypted).not.toContain('gho_test123');
      
      const decrypted = decryptCredential(encrypted) as OAuthTokens;
      expect(typeof decrypted).toBe('object');
      expect(decrypted.accessToken).toBe(tokens.accessToken);
      expect(decrypted.refreshToken).toBe(tokens.refreshToken);
      expect(decrypted.expiresAt).toBe(tokens.expiresAt);
      expect(decrypted.scope).toBe(tokens.scope);
    });
    
    it('should produce different ciphertext for same input (random IV)', () => {
      const apiKey = 'sk-test-same-input';
      const encrypted1 = encryptCredential(apiKey);
      const encrypted2 = encryptCredential(apiKey);
      
      expect(encrypted1).not.toBe(encrypted2);
      
      expect(decryptCredential(encrypted1)).toBe(apiKey);
      expect(decryptCredential(encrypted2)).toBe(apiKey);
    });
    
    it('should handle empty string', () => {
      const empty = '';
      const encrypted = encryptCredential(empty);
      const decrypted = decryptCredential(encrypted);
      expect(decrypted).toBe(empty);
    });
    
    it('should handle very long API keys', () => {
      const longKey = 'x'.repeat(1000);
      const encrypted = encryptCredential(longKey);
      const decrypted = decryptCredential(encrypted);
      expect(decrypted).toBe(longKey);
    });
    
    it('should handle special characters', () => {
      const specialKey = 'sk-test_!@#$%^&*(){}[]|\\:";\'<>?,./~`';
      const encrypted = encryptCredential(specialKey);
      const decrypted = decryptCredential(encrypted);
      expect(decrypted).toBe(specialKey);
    });
    
    it('should handle unicode characters', () => {
      const unicodeKey = 'test-日本語-emoji-🔐-key';
      const encrypted = encryptCredential(unicodeKey);
      const decrypted = decryptCredential(encrypted);
      expect(decrypted).toBe(unicodeKey);
    });
    
    it('should throw error if VAULT_ENCRYPTION_KEY is not set', () => {
      const originalKey = process.env.VAULT_ENCRYPTION_KEY;
      delete process.env.VAULT_ENCRYPTION_KEY;
      
      expect(() => encryptCredential('test')).toThrow('VAULT_ENCRYPTION_KEY');
      
      process.env.VAULT_ENCRYPTION_KEY = originalKey;
    });
    
    it('should throw error if VAULT_ENCRYPTION_KEY is wrong length', () => {
      const originalKey = process.env.VAULT_ENCRYPTION_KEY;
      process.env.VAULT_ENCRYPTION_KEY = 'tooshort';
      
      expect(() => encryptCredential('test')).toThrow('32 bytes');
      
      process.env.VAULT_ENCRYPTION_KEY = originalKey;
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
      
      expect(sanitized.serverId).toBe('buffer-mcp');
      expect(sanitized.normalField).toBe('visible');
      expect(sanitized.value).toBe('[REDACTED]');
      expect(sanitized.apiKey).toBe('[REDACTED]');
      expect(sanitized.accessToken).toBe('[REDACTED]');
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
      
      expect(sanitized.publicData).toBe('visible');
      expect(sanitized.meta.serverId).toBe('github-mcp');
      expect(sanitized.meta.credentials.accessToken).toBe('[REDACTED]');
      expect(sanitized.meta.credentials.refreshToken).toBe('[REDACTED]');
    });
    
    it('should handle arrays', () => {
      const arr = [
        { id: 1, apiKey: 'key1' },
        { id: 2, apiKey: 'key2' },
      ];
      
      const sanitized = sanitizeForLogging(arr);
      
      expect(sanitized[0].id).toBe(1);
      expect(sanitized[0].apiKey).toBe('[REDACTED]');
      expect(sanitized[1].id).toBe(2);
      expect(sanitized[1].apiKey).toBe('[REDACTED]');
    });
    
    it('should handle case-insensitive matching', () => {
      const obj = {
        ApiKey: 'secret',
        API_KEY: 'secret',
        access_token: 'secret',
        RefreshToken: 'secret',
      };
      
      const sanitized = sanitizeForLogging(obj);
      
      expect(sanitized.ApiKey).toBe('[REDACTED]');
      expect(sanitized.API_KEY).toBe('[REDACTED]');
      expect(sanitized.access_token).toBe('[REDACTED]');
      expect(sanitized.RefreshToken).toBe('[REDACTED]');
    });
    
    it('should not modify primitives', () => {
      expect(sanitizeForLogging('string')).toBe('string');
      expect(sanitizeForLogging(123)).toBe(123);
      expect(sanitizeForLogging(true)).toBe(true);
      expect(sanitizeForLogging(null)).toBe(null);
    });
  });
});
