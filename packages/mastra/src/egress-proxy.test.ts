import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { EgressProxy, isHostAllowed, parseHostPort } from './egress-proxy';

describe('isHostAllowed', () => {
  it('returns false for empty allow-list', () => {
    assert.equal(isHostAllowed('api.example.com', []), false);
    assert.equal(isHostAllowed('1.2.3.4', []), false);
  });

  it('matches exact hostname', () => {
    const allowList = ['api.example.com', 'db.internal.net'];
    assert.equal(isHostAllowed('api.example.com', allowList), true);
    assert.equal(isHostAllowed('db.internal.net', allowList), true);
    assert.equal(isHostAllowed('other.example.com', allowList), false);
  });

  it('matches exact IP address', () => {
    const allowList = ['1.2.3.4', '10.0.0.1'];
    assert.equal(isHostAllowed('1.2.3.4', allowList), true);
    assert.equal(isHostAllowed('10.0.0.1', allowList), true);
    assert.equal(isHostAllowed('1.2.3.5', allowList), false);
  });

  it('matches wildcard subdomain', () => {
    const allowList = ['*.example.com'];
    assert.equal(isHostAllowed('api.example.com', allowList), true);
    assert.equal(isHostAllowed('sub.api.example.com', allowList), true);
    assert.equal(isHostAllowed('example.com', allowList), false);
    assert.equal(isHostAllowed('other.net', allowList), false);
  });

  it('matches CIDR notation for IPv4', () => {
    const allowList = ['10.0.0.0/8', '192.168.1.0/24'];
    assert.equal(isHostAllowed('10.0.0.1', allowList), true);
    assert.equal(isHostAllowed('10.255.255.255', allowList), true);
    assert.equal(isHostAllowed('11.0.0.1', allowList), false);
    assert.equal(isHostAllowed('192.168.1.1', allowList), true);
    assert.equal(isHostAllowed('192.168.1.255', allowList), true);
    assert.equal(isHostAllowed('192.168.2.1', allowList), false);
  });

  it('strips port from hostname before matching', () => {
    const allowList = ['api.example.com', '10.0.0.1'];
    assert.equal(isHostAllowed('api.example.com:443', allowList), true);
    assert.equal(isHostAllowed('10.0.0.1:3000', allowList), true);
    assert.equal(isHostAllowed('other.com:443', allowList), false);
  });
});

describe('parseHostPort', () => {
  it('parses host:port and IPv6 brackets', () => {
    assert.deepEqual(parseHostPort('example.com:8080'), { host: 'example.com', port: 8080 });
    assert.deepEqual(parseHostPort('[::1]:443'), { host: '::1', port: 443 });
    assert.deepEqual(parseHostPort('example.com'), { host: 'example.com' });
  });
});

function listenOrigin(body: string): Promise<{ close: () => Promise<void>; port: number; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

function requestViaProxy(proxyPort: number, targetUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path: targetUrl,
        method: 'GET',
        headers: { Host: parsed.host },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

describe('EgressProxy enforcement', () => {
  it('allows an allow-listed host and denies others; empty list denies all', async () => {
    const allowed = await listenOrigin('allowed-ok');
    const denied = await listenOrigin('denied-should-not-see');
    const allowProxy = new EgressProxy({
      allowList: ['127.0.0.1'],
      companyId: 'co-test',
    });
    const emptyProxy = new EgressProxy({
      allowList: [],
      companyId: 'co-empty',
    });

    try {
      const allowPort = await allowProxy.start();
      const emptyPort = await emptyProxy.start();

      const allowedHit = await requestViaProxy(allowPort, allowed.url);
      assert.equal(allowedHit.status, 200, 'allow-listed 127.0.0.1 must connect');
      assert.equal(allowedHit.body, 'allowed-ok');

      const deniedHit = await requestViaProxy(allowPort, 'http://example.com/');
      assert.equal(deniedHit.status, 403, 'host not on the list must fail');
      assert.match(deniedHit.body, /not in the egress allow-list/);

      const emptyToAllowed = await requestViaProxy(emptyPort, allowed.url);
      assert.equal(emptyToAllowed.status, 403, 'empty allow-list means no network');

      const emptyToDenied = await requestViaProxy(emptyPort, denied.url);
      assert.equal(emptyToDenied.status, 403, 'empty allow-list denies every host');
    } finally {
      await allowProxy.stop();
      await emptyProxy.stop();
      await allowed.close();
      await denied.close();
    }
  });

  it('CONNECT to a denied host is 403', async () => {
    const proxy = new EgressProxy({ allowList: ['127.0.0.1'], companyId: 'co-connect' });
    const port = await proxy.start();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({
          host: '127.0.0.1',
          port,
          method: 'CONNECT',
          path: 'example.com:443',
        });
        req.on('connect', (res, socket) => {
          socket.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on('response', (res) => {
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 403);
    } finally {
      await proxy.stop();
    }
  });
});
