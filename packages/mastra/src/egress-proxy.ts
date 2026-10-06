import * as http from 'node:http';
import * as net from 'node:net';
import { chmodSync, unlinkSync } from 'node:fs';
import { createTraceLogger } from '@tourbillon/shared';

const logger = createTraceLogger('egress-proxy', {});

export function parseHostPort(target: string): { host: string; port?: number } {
  const trimmed = target.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) return { host: trimmed };
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    if (rest.startsWith(':')) {
      const port = parseInt(rest.slice(1), 10);
      return { host, port: Number.isFinite(port) ? port : undefined };
    }
    return { host };
  }
  const idx = trimmed.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(trimmed.slice(idx + 1))) {
    return { host: trimmed.slice(0, idx), port: parseInt(trimmed.slice(idx + 1), 10) };
  }
  return { host: trimmed };
}

function isIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d+$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

function matchesCidr(ip: string, cidr: string): boolean {
  if (!isIpv4(ip)) return false;
  const [network, prefixStr] = cidr.split('/');
  if (!network || prefixStr === undefined || !isIpv4(network)) return false;
  const prefix = parseInt(prefixStr, 10);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return false;

  const ipInt = ip.split('.').reduce((acc, octet) => (acc << 8) | Number(octet), 0) >>> 0;
  const networkInt = network.split('.').reduce((acc, octet) => (acc << 8) | Number(octet), 0) >>> 0;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (networkInt & mask);
}

/**
 * Whether a hostname or IP is in the allow-list.
 * Entries: exact host, IPv4, `*.example.com`, or IPv4 CIDR.
 */
export function isHostAllowed(host: string, allowList: string[]): boolean {
  if (allowList.length === 0) return false;
  const hostWithoutPort = parseHostPort(host).host.replace(/^\[|\]$/g, '').toLowerCase();

  for (const raw of allowList) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === hostWithoutPort) return true;
    if (entry.startsWith('*.')) {
      const domain = entry.slice(2);
      if (hostWithoutPort.endsWith(`.${domain}`)) return true;
    }
    if (entry.includes('/') && matchesCidr(hostWithoutPort, entry)) return true;
  }
  return false;
}

export interface EgressProxyOptions {
  allowList: string[];
  companyId: string;
  taskId?: string;
}

export class EgressProxy {
  private server: http.Server | null = null;
  private port = 0;
  private socketPath: string | undefined;
  private readonly allowList: string[];
  private readonly companyId: string;
  private readonly taskId?: string;

  constructor(options: EgressProxyOptions) {
    this.allowList = options.allowList;
    this.companyId = options.companyId;
    this.taskId = options.taskId;
  }

  async start(listen: { socketPath: string } | { tcp: true } = { tcp: true }): Promise<number> {
    if (this.server) {
      throw new Error('Proxy already started');
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });

      this.server.on('connect', (req, clientSocket, head) => {
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
    if (!this.server) return;
    const socketPath = this.socketPath;

    return new Promise((resolve, reject) => {
      this.server!.closeAllConnections?.();
      this.server!.close((err) => {
        if (socketPath) {
          try {
            unlinkSync(socketPath);
          } catch {
            /* already gone */
          }
        }
        if (err) {
          logger.error('Error stopping proxy', {
            companyId: this.companyId,
            taskId: this.taskId,
            error: err.message,
          });
          reject(err);
        } else {
          this.server = null;
          this.port = 0;
          this.socketPath = undefined;
          resolve();
        }
      });
    });
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
    const target = this.resolveTargetHost(req);
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request: No URL specified');
      return;
    }

    if (!isHostAllowed(target.host, this.allowList)) {
      logger.warn('Blocked HTTP request', {
        companyId: this.companyId,
        taskId: this.taskId,
        host: target.host,
        method: req.method,
      });
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(`Forbidden: Host '${target.host}' is not in the egress allow-list`);
      return;
    }

    const proxyReq = http.request(
      {
        hostname: target.host,
        port: target.port,
        path: target.path,
        method: req.method,
        headers: req.headers,
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
        error: err.message,
      });
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end(`Bad Gateway: ${err.message}`);
    });

    req.pipe(proxyReq);
  }

  private handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
    const { host, port } = parseHostPort(req.url || '');
    const destPort = port ?? 443;

    if (!host || !isHostAllowed(host, this.allowList)) {
      logger.warn('Blocked HTTPS CONNECT', {
        companyId: this.companyId,
        taskId: this.taskId,
        host,
      });
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.end(`Forbidden: Host '${host}' is not in the egress allow-list`);
      return;
    }

    const serverSocket = net.connect(destPort, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', (err) => {
      logger.error('CONNECT tunnel error', {
        companyId: this.companyId,
        taskId: this.taskId,
        host,
        error: err.message,
      });
      clientSocket.end();
    });

    clientSocket.on('error', () => {
      serverSocket.end();
    });
  }
}
