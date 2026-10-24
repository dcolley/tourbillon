/** OBS-1: Phoenix UI base URL for trace links (hidden when unset or unsafe). */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { phoenixUiBaseUrl } from '../observability';

describe('OBS-1 phoenixUiBaseUrl', () => {
  const saved = process.env.PHOENIX_UI_BASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.PHOENIX_UI_BASE_URL;
    else process.env.PHOENIX_UI_BASE_URL = saved;
  });
  const withEnv = (value: string | undefined) => {
    if (value === undefined) delete process.env.PHOENIX_UI_BASE_URL;
    else process.env.PHOENIX_UI_BASE_URL = value;
    return phoenixUiBaseUrl();
  };

  it('unset or blank → undefined', () => {
    assert.equal(withEnv(undefined), undefined);
    assert.equal(withEnv('   '), undefined);
  });

  it('http(s) URL → normalised base without trailing slash, query or hash', () => {
    assert.equal(withEnv('http://localhost:6006'), 'http://localhost:6006');
    assert.equal(withEnv('https://phoenix.example.com/'), 'https://phoenix.example.com');
    assert.equal(withEnv(' https://phoenix.example.com/base/?x=1#y '), 'https://phoenix.example.com/base');
  });

  it('other schemes, credentials or junk → undefined', () => {
    assert.equal(withEnv('javascript:alert(1)'), undefined);
    assert.equal(withEnv('ftp://phoenix.example.com'), undefined);
    assert.equal(withEnv('https://user:pass@phoenix.example.com'), undefined);
    assert.equal(withEnv('not a url'), undefined);
  });
});
