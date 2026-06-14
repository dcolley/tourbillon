declare module 'redlock' {
  import type { Cluster, Redis } from 'ioredis';

  export class Lock {
    release(): Promise<unknown>;
  }

  export default class Redlock {
    constructor(
      clients: Iterable<Redis | Cluster>,
      settings?: Partial<{ retryCount: number }>,
    );
    acquire(resources: string[], duration: number): Promise<Lock>;
  }
}
