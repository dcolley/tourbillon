import { randomUUID } from 'crypto';

export function createId(): string {
  return randomUUID();
}
