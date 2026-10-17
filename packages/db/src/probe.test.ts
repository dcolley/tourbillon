import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { DatabaseUrlError, describeDbError } from './database-url';
import { probeDatabase } from './probe';

/** A TCP server that accepts connections and never answers: a stalled database. */
let server: net.Server;
let port = 0;
const sockets = new Set<net.Socket>();
let finsReceived = 0;

before(async () => {
  server = net.createServer((s) => {
    sockets.add(s);
    s.resume(); // flowing mode, so 'end' fires
    s.on('close', () => sockets.delete(s));
    // The client closing its side (FIN) is what a real server acts on; this stub never answers.
    s.on('end', () => {
      finsReceived += 1;
      s.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as net.AddressInfo).port;
});

after(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('probeDatabase', () => {
  it('rejects a malformed URL before opening a socket', async () => {
    await assert.rejects(probeDatabase({ url: 'postgres://u:pw@h:99999/db' }), DatabaseUrlError);
    assert.equal(sockets.size, 0);
  });

  it('abort ends the stalled client promptly and closes its socket', async () => {
    const controller = new AbortController();
    const finsBefore = finsReceived;
    const started = Date.now();
    const p = probeDatabase({ url: `postgres://u:pw@127.0.0.1:${port}/db`, timeoutMs: 30_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(p);
    assert.ok(Date.now() - started < 5_000, 'did not wait for connect_timeout');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(finsReceived, finsBefore + 1, 'client closed its connection');
    assert.equal(sockets.size, 0);
  });

  it('connect_timeout bounds a stalled handshake without a signal', async () => {
    const started = Date.now();
    await assert.rejects(probeDatabase({ url: `postgres://u:pw@127.0.0.1:${port}/db`, timeoutMs: 1_000 }));
    assert.ok(Date.now() - started < 4_000);
  });
});

/** Minimal server that answers the startup packet with a Postgres ErrorResponse. */
async function withErrorServer(code: string, message: string, fn: (port: number) => Promise<void>): Promise<void> {
  const field = (t: string, v: string) => Buffer.concat([Buffer.from(t), Buffer.from(v), Buffer.from([0])]);
  const body = Buffer.concat([field('S', 'FATAL'), field('V', 'FATAL'), field('C', code), field('M', message), Buffer.from([0])]);
  const len = Buffer.alloc(4);
  len.writeInt32BE(body.length + 4);
  const packet = Buffer.concat([Buffer.from('E'), len, body]);
  const srv = net.createServer((s) => {
    s.once('data', () => s.end(packet));
    s.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  try {
    await fn((srv.address() as net.AddressInfo).port);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

describe('probeDatabase: real driver errors come out with code and a clean message', () => {
  for (const [code, message] of [
    ['28P01', 'password authentication failed for user "tb_user"'],
    ['3D000', 'database "nope" does not exist'],
  ] as const) {
    it(code, async () => {
      await withErrorServer(code, message, async (p) => {
        const url = `postgres://tb_user:Sup3r-s3cret@127.0.0.1:${p}/nope`;
        let caught: unknown;
        await probeDatabase({ url, timeoutMs: 5_000 }).catch((err) => {
          caught = err;
        });
        assert.ok(caught, 'rejected');
        assert.deepEqual(describeDbError(caught, url), { message, code });
      });
    });
  }
});
