import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { LocalSandbox } from '@mastra/core/workspace';
import { buildEgressFilterEnv, landlockNetAvailable } from './egress-enforcement';

describe('Sandbox DNS and /dev/null', () => {
  it('/dev/null exists and is usable in LocalSandbox', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tourbillon-devnull-'));
    const sandbox = new LocalSandbox({
      workingDirectory: cwd,
      isolation: 'none',
      timeout: 15_000,
    });
    await sandbox.start();
    try {
      const result = await sandbox.executeCommand?.('sh', [
        '-c',
        'test -e /dev/null && test -w /dev/null && echo proof >/dev/null && echo success',
      ]);
      assert.ok(result, 'executeCommand must be available');
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /success/);
    } finally {
      await sandbox.destroy();
    }
  });

  it('DNS resolution works under the egress filter (allowed-host path)', { skip: !landlockNetAvailable() }, () => {
    const env = buildEgressFilterEnv({ proxyPort: 9 });
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
        const dns = require('dns');
        dns.lookup('localhost', (err, addr) => {
          if (err) { console.error(err); process.exit(1); }
          if (!addr) process.exit(2);
          console.log(addr);
          process.exit(0);
        });
        `,
      ],
      { env: { ...process.env, ...env }, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `DNS must work (stderr=${result.stderr})`);
    assert.match(result.stdout.trim(), /^(127\.0\.0\.1|::1)$/);
  });
});
