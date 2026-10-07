import * as http from 'node:http';
import * as net from 'node:net';
import { chmodSync, unlinkSync } from 'node:fs';
import { createTraceLogger } from '@tourbillon/shared';
import {
  authorizeEgressTarget,
  parseHostPort,
  type HostResolver,
} from './egress-private-ranges';

export { isHostAllowed, parseHostPort } from './egress-private-ranges';

const logger = createTraceLogger('egress-proxy', {});

export interface EgressProxyOptions {
  allowList: string[];
  companyId: string;
  taskId?: string;
  /**
   * Legacy `allowNetwork: true` with no list: any public destination is
   * allowed; blocked private ranges are still refused.
   */
  publicInternet?: boolean;
  /** Injected resolver for tests (resolve-then-pin). */
  resolve?: HostResolver;
}

export class EgressProxy {
  private server: http.Server | null = null;
  private port = 0;
  private socketPath: string | undefined;
  private readonly allowList: string[];
  private readonly companyId: string;
  private readonly taskId?: string;
  private readonly publicInternet: boolean;
  private readonly resolve?: HostResolver;

  constructor(options: EgressProxyOptions) {
    this.allowList = options.allowList;
    this.companyId = options.companyId;
    this.taskId = options.taskId;
    this.publicInternet = options.publicInternet === true;
    this.resolve = options.resolve;
  }

  async start(listen: { socketPath: string } | { tcp: true } = { tcp: true }): Promise<number> {
    if (this.server) {
      throw new Error('Proxy already started');
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });

      this.server.on('connect', (req, clientSocket: net.Duplex, head) => {
        this.handleConnect(req, clientSocket, head);
      });

      this.server.on('error', (err) => {
        logger.error('Proxy server error', {
          companyId: this.companyId,
          taskId: this.taskId,
          error: err.message,
        });
        reject(err);
      });

      const onListening = () => {
        if (this.socketPath) {
          logger.info('Egress proxy started (unix)', {
            companyId: this.companyId,
            taskId: this.taskId,
            socketPath: this.socketPath,
          });
          resolve(0);
          return;
        }
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          logger.info('Egress proxy started', {
            companyId: this.companyId,
            taskId: this.taskId,
            port: this.port,
          });
          resolve(this.port);
        } else {
          reject(new Error('Failed to get proxy address'));
        }
      };

      if ('socketPath' in listen) {
        const pathBytes = Buffer.byteLength(listen.socketPath, 'utf8');
        if (pathBytes > 107) {
          reject(
            new Error(
              `Egress proxy unix socket path is ${pathBytes} bytes (max 107). ` +
                'Refusing to start; never truncating.',
            ),
          );
          this.server = null;
          return;
        }
        this.socketPath = listen.socketPath;
        try {
          unlinkSync(listen.socketPath);
        } catch {
          /* missing is fine */
        }
        this.server.listen(listen.socketPath, () => {
          /* User-ns sandboxes see a different uid; world-connect is required. */
          try {
            chmodSync(listen.socketPath, 0o666);
          } catch {
            /* chmod is best-effort; same-uid hosts still connect */
          }
          onListening();
        });
      } else {
        this.server.listen(0, '127.0.0.1', onListening);
      }
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return; // idempotent: second stop() is a no-op

    const socketPath = this.socketPath;

    const closeError = await new Promise<Error | null>((resolve) => {
      let settled = false;
      const done = (err: Error | null) => {
        if (settled) return;
        settled = true;
        resolve(err);
      };
      // Let idle keep-alive sockets/tunnels drain so close() can settle.
      server.closeAllConnections?.();
      server.close((err) => {
        done(err ?? null);
      });
      // Do not hang teardown if the listener never drains (stale keep-alive
      // tunnels, or an errored listener with no fd). close() on an
      // already-closed handle calls back with an error, which still resolves —
      // the timeout only covers a handle that never drains.
      setTimeout(() => {
        done(null);
      }, 2_000).unref();
    });

    // Always best-effort unlink and always clear state, even when close()
    // errored: rejecting on close error used to leave the unix socket bound
    // on disk because callers skipped the unlink when stop() rejected.
    if (socketPath) {
      try {
        unlinkSync(socketPath);
      } catch {
        /* already gone */
      }
    }

    this.server = null;
    this.port = 0;
    this.socketPath = undefined;

    if (closeError) {
      logger.error('Error stopping proxy (socket unlinked anyway)', {
        companyId: this.companyId,
        taskId: this.taskId,
        error: closeError.message,
      });
      return;
    }

    if (socketPath) {
      logger.info('Egress proxy stopped (unix)', {
        companyId: this.companyId,
        taskId: this.taskId,
        socketPath,
      });
    }
  }

  getPort(): number {
    return this.port;
  }

  getSocketPath(): string | undefined {
    return this.socketPath;
  }

  private resolveTargetHost(req: http.IncomingMessage): { host: string; port: number; path: string } | null {
    const rawUrl = req.url;
    if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
      try {
        const parsed = new URL(rawUrl);
        return {
          host: parsed.hostname,
          port: parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80,
          path: `${parsed.pathname}${parsed.search}`,
        };
      } catch {
        return null;
      }
    }
    const hostHeader = req.headers.host;
    if (!hostHeader) return null;
    const { host, port } = parseHostPort(hostHeader);
    return { host, port: port ?? 80, path: rawUrl && rawUrl.startsWith('/') ? rawUrl : '/' };
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    void this.handleHttpRequestAsync(req, res);
  }

  private async handleHttpRequestAsync(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const target = this.resolveTargetHost(req);
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request: No URL specified');
      return;
    }

    const decision = await authorizeEgressTarget({
      host: target.host,
      allowList: this.allowList,
      publicInternet: this.publicInternet,
      resolve: this.resolve,
    });

    if (!decision.allowed) {
      logger.warn('Blocked HTTP request', {
        companyId: this.companyId,
        taskId: this.taskId,
        host: target.host,
        reason: decision.reason,
        method: req.method,
      });
      res.writeHead(decision.status, { 'Content-Type': 'text/plain' });
      res.end(decision.detail);
      return;
    }

    const headers = { ...req.headers };
    if (!headers.host) {
      headers.host = target.port === 80 ? target.host : `${target.host}:${target.port}`;
    }

    const proxyReq = http.request(
      {
        hostname: decision.pin.address,
        port: target.port,
        path: target.path,
        method: req.method,
        headers,
        family: decision.pin.family,
        createConnection: () =>
          net.connect({
            port: target.port,
            host: decision.pin.address,
            family: decision.pin.family,
          }),
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      logger.error('Proxy request error', {
        companyId: this.companyId,
        taskId: this.taskId,
        host: target.host,
        pin: decision.pin.address,
        error: err.message,
      });
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end(`Bad Gateway: ${err.message}`);
    });

    req.pipe(proxyReq);
  }

  private handleConnect(req: http.IncomingMessage, clientSocket: net.Duplex, head: Buffer): void {
    void this.handleConnectAsync(req, clientSocket, head);
  }

  private async handleConnectAsync(
    req: http.IncomingMessage,
    clientSocket: net.Duplex,
    head: Buffer,
  ): Promise<void> {
    const { host, port } = parseHostPort(req.url || '');
    const destPort = port ?? 443;

    const decision = await authorizeEgressTarget({
      host: host || '',
      allowList: this.allowList,
      publicInternet: this.publicInternet,
      resolve: this.resolve,
    });

    if (!decision.allowed) {
      logger.warn('Blocked HTTPS CONNECT', {
        companyId: this.companyId,
        taskId: this.taskId,
        host,
        reason: decision.reason,
      });
      const code = decision.status === 502 ? '502 Bad Gateway' : '403 Forbidden';
      clientSocket.write(`HTTP/1.1 ${code}\r\n\r\n`);
      clientSocket.end(decision.detail);
      return;
    }

    const serverSocket = net.connect(
      { port: destPort, host: decision.pin.address, family: decision.pin.family },
      () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
      },
    );

    serverSocket.on('error', (err) => {
      logger.error('CONNECT tunnel error', {
        companyId: this.companyId,
        taskId: this.taskId,
        host,
        pin: decision.pin.address,
        error: err.message,
      });
      clientSocket.end();
    });

    clientSocket.on('error', () => {
      serverSocket.end();
    });
  }
}
