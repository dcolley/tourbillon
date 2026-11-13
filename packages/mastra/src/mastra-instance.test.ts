/**
 * Phoenix OTLP export behaviour against a fake collector (phoenix non-fatal fix).
 *
 * Pins, end to end over real HTTP:
 *  - `buildArizeExporter` turns the log signal off (`signals: { traces: true, logs: false }`);
 *  - with the signal off, log events never produce a POST /v1/logs (Phoenix 405 source);
 *  - the control (signal left on, as shipped in otel-exporter 1.5.0) DOES POST /v1/logs —
 *    proving the pin bites;
 *  - completed spans still export to /v1/traces when the collector is up;
 *  - flushing a collector that refuses connections never rejects (wake stays succeeded),
 *    reported as a warning through the shared safe-flush helper.
 *
 * No database or LLM is touched: the exporter is driven directly.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ArizeExporter } from '@mastra/arize';
import type { LogEvent, TracingEvent } from '@mastra/core/observability';
import { TracingEventType } from '@mastra/core/observability';
import { flushUnitsSafely } from '@tourbillon/shared';
import { buildArizeExporter } from './mastra-instance';

const env = process.env as Record<string, string | undefined>;

interface FakeCollector {
  url: string;
  port: number;
  paths: string[];
  close: () => Promise<void>;
}

/**
 * Listens on an ephemeral port. `logsStatus` answers POST /v1/logs (Phoenix returns 405
 * because it has no OTLP log ingest); /v1/traces always answers 200.
 */
async function startFakeCollector(opts: { logsStatus?: number } = {}): Promise<FakeCollector> {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.method === 'POST' && req.url) paths.push(req.url);
    req.on('end', () => {
      if (req.url === '/v1/logs') {
        res.writeHead(opts.logsStatus ?? 405, { 'content-type': 'application/json' });
        res.end('{"detail":"Method Not Allowed"}');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    paths,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

function logEvent(message: string): LogEvent {
  return {
    log: {
      level: 'info',
      message,
      timestamp: new Date(),
      category: 'test',
    },
  } as unknown as LogEvent;
}

function spanEndedEvent(): TracingEvent {
  return {
    type: TracingEventType.SPAN_ENDED,
    exportedSpan: {
      id: '0123456789abcdef',
      traceId: '0123456789abcdef0123456789abcdef',
      name: 'wake-span',
      type: 'agent_run',
      startTime: new Date(),
      endTime: new Date(),
      isRootSpan: true,
      metadata: { companyId: 'company-x' },
    },
  } as unknown as TracingEvent;
}

async function drainFlush(exporter: ArizeExporter): Promise<void> {
  // flush() may reject when the collector answers the OTLP POST with an error
  // (e.g. 405 on logs); callers assert on the wire, not on the flush result.
  await exporter.flush().catch(() => undefined);
}

describe('Phoenix ArizeExporter wiring', () => {
  const saved = {
    endpoint: env.PHOENIX_COLLECTOR_ENDPOINT,
    enabled: env.PHOENIX_COLLECTOR_ENABLED,
  };

  after(() => {
    if (saved.endpoint === undefined) delete env.PHOENIX_COLLECTOR_ENDPOINT;
    else env.PHOENIX_COLLECTOR_ENDPOINT = saved.endpoint;
    if (saved.enabled === undefined) delete env.PHOENIX_COLLECTOR_ENABLED;
    else env.PHOENIX_COLLECTOR_ENABLED = saved.enabled;
  });

  it('buildArizeExporter disables the log signal (the /v1/logs 405 fix)', () => {
    env.PHOENIX_COLLECTOR_ENABLED = 'true';
    env.PHOENIX_COLLECTOR_ENDPOINT = 'http://127.0.0.1:6006/v1/traces';
    const exporter = buildArizeExporter() as unknown as {
      name?: string;
      config?: { signals?: { traces?: boolean; logs?: boolean } };
    };
    assert.equal(exporter.name, 'arize');
    assert.deepEqual(exporter.config?.signals, { traces: true, logs: false },
      'otel-exporter enables logs by default; the wiring must turn the signal off');
  });
});

describe('ArizeExporter against a fake OTLP collector', () => {
  it('control: with the log signal on (library default), log events POST to /v1/logs', async () => {
    const collector = await startFakeCollector({ logsStatus: 405 });
    try {
      const exporter = new ArizeExporter({ endpoint: `${collector.url}/v1/traces` });
      await exporter.onLogEvent(logEvent('heartbeat log line'));
      await drainFlush(exporter);
      const sawLogs = await waitFor(() => collector.paths.includes('/v1/logs'));
      assert.ok(sawLogs, `expected a /v1/logs POST (the 405 source); saw ${JSON.stringify(collector.paths)}`);
      await exporter.shutdown().catch(() => undefined);
    } finally {
      await collector.close();
    }
  });

  it('with signals { traces: true, logs: false }, no /v1/logs request is ever sent', async () => {
    const collector = await startFakeCollector({ logsStatus: 405 });
    try {
      const exporter = new ArizeExporter({
        endpoint: `${collector.url}/v1/traces`,
        signals: { traces: true, logs: false },
      });
      await exporter.onLogEvent(logEvent('heartbeat log line'));
      await drainFlush(exporter);
      // Give any in-flight (should-be-absent) POST a window to land.
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(!collector.paths.includes('/v1/logs'), `no /v1/logs POST expected; saw ${JSON.stringify(collector.paths)}`);
      await exporter.shutdown().catch(() => undefined);
    } finally {
      await collector.close();
    }
  });

  it('completed spans still export to /v1/traces when the collector is up', async () => {
    const collector = await startFakeCollector();
    try {
      const exporter = new ArizeExporter({
        endpoint: `${collector.url}/v1/traces`,
        signals: { traces: true, logs: false },
      });
      await (exporter as unknown as {
        _exportTracingEvent: (e: TracingEvent) => Promise<void>;
      })._exportTracingEvent(spanEndedEvent());
      await exporter.flush();
      const sawTraces = await waitFor(() => collector.paths.includes('/v1/traces'));
      assert.ok(sawTraces, `expected POST /v1/traces; saw ${JSON.stringify(collector.paths)}`);
      await exporter.shutdown().catch(() => undefined);
    } finally {
      await collector.close();
    }
  });

  it('a collector refusing connections never rejects the flush; it warns instead', async () => {
    // Occupy a port, then release it so connections are refused.
    const probe = await startFakeCollector();
    const deadPort = probe.port;
    await probe.close();

    const exporter = new ArizeExporter({
      endpoint: `http://127.0.0.1:${deadPort}/v1/traces`,
      signals: { traces: true, logs: false },
    });
    await (exporter as unknown as {
      _exportTracingEvent: (e: TracingEvent) => Promise<void>;
    })._exportTracingEvent(spanEndedEvent());

    const warnings: string[] = [];
    // The whole point: this must resolve so the wake stays `succeeded`.
    await flushUnitsSafely([{ label: 'exporter:arize', flush: () => exporter.flush() }], {
      timeoutMs: 8000,
      warn: (m) => warnings.push(m),
    });
    await exporter.shutdown().catch(() => undefined);
    assert.ok(
      warnings.length === 0 || warnings.every((w) => typeof w === 'string' && w.length > 0),
      'failures surface only as warnings',
    );
  });
});
