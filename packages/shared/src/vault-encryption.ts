import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { OAuthTokens } from '@tourbillon/db/schema';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = process.env.VAULT_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('VAULT_ENCRYPTION_KEY environment variable is not set');
  }
  
  let keyBuffer: Buffer;
  try {
    keyBuffer = Buffer.from(key, 'hex');
  } catch {
    keyBuffer = Buffer.from(key, 'base64');
  }
  
  if (keyBuffer.length !== 32) {
    throw new Error('VAULT_ENCRYPTION_KEY must be 32 bytes (64 hex chars or 44 base64 chars)');
  }
  
  return keyBuffer;
}

export function encryptCredential(plaintext: string | OAuthTokens): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  
  const plaintextString = typeof plaintext === 'string' 
    ? plaintext 
    : JSON.stringify(plaintext);
  
  let encrypted = cipher.update(plaintextString, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  const result = Buffer.concat([
    iv,
    authTag,
    Buffer.from(encrypted, 'hex'),
  ]).toString('base64');
  
  return result;
}

export function decryptCredential(ciphertext: string): string | OAuthTokens {
  const key = getEncryptionKey();
  const data = Buffer.from(ciphertext, 'base64');
  
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encrypted, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  
  try {
    const parsed = JSON.parse(decrypted);
    if (parsed && typeof parsed === 'object' && 'accessToken' in parsed) {
      return parsed as OAuthTokens;
    }
    return decrypted;
  } catch {
    return decrypted;
  }
}

export function sanitizeForLogging(obj: any): any {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }
  
  const sensitiveKeys = [
    'value',
    'apiKey',
    'api_key',
    'accessToken',
    'access_token',
    'refreshToken',
    'refresh_token',
    'encryptedValue',
    'encrypted_value',
    'password',
    'secret',
    'token',
    'credential',
    'bufferApiKey',
    'tavilyApiKey',
    'searxngApiKey',
  ];
  
  const sanitized = Array.isArray(obj) ? [...obj] : { ...obj };
  
  for (const key in sanitized) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some((sk) => lowerKey.includes(sk.toLowerCase()))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
      sanitized[key] = sanitizeForLogging(sanitized[key]);
    }
  }
  
  return sanitized;
}
