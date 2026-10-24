/** CHAT-1: attachment rules shared by the composer and the upload route. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_ATTACHMENT_ACCEPT,
  CHAT_ATTACHMENT_MAX_BYTES,
  attachmentContentMatches,
  attachmentDisplayName,
  attachmentExtension,
  chatAttachmentDir,
  checkChatAttachment,
  formatBytes,
  messageWithAttachments,
  storedAttachmentName,
  workspaceSegment,
} from './chat-attachments';

describe('CHAT-1 checkChatAttachment', () => {
  it('accepts allowed types and takes the media type from the extension', () => {
    assert.deepEqual(checkChatAttachment({ name: 'Shot.PNG', size: 10, type: 'application/octet-stream' }), {
      ok: true,
      ext: 'png',
      kind: 'image',
      mediaType: 'image/png',
    });
    for (const name of ['a.pdf', 'b.docx', 'c.xlsx', 'd.md', 'e.csv', 'f.json', 'g.yaml', 'h.txt', 'i.jpeg', 'j.webp']) {
      assert.equal(checkChatAttachment({ name, size: 1 }).ok, true, name);
    }
  });

  it('refuses executables, scripts and web pages with a clear message', () => {
    for (const name of ['setup.exe', 'run.sh', 'x.ps1', 'page.html', 'logo.svg', 'macro.docm', 'app.jar']) {
      const r = checkChatAttachment({ name, size: 10 });
      assert.equal(r.ok, false, name);
      if (!r.ok) {
        assert.equal(r.code, 'blocked_type');
        assert.match(r.message, /can't be attached/);
        assert.ok(r.message.startsWith(name), r.message);
      }
    }
    const byMime = checkChatAttachment({ name: 'notes.txt', size: 10, type: 'application/x-msdownload' });
    assert.equal(byMime.ok, false);
    if (!byMime.ok) assert.equal(byMime.code, 'blocked_type');
  });

  it('refuses unknown types and files without an extension', () => {
    const r = checkChatAttachment({ name: 'archive.7z', size: 10 });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, 'unsupported_type');
      assert.match(r.message, /\.7z files aren't supported/);
      assert.match(r.message, /Allowed: images, PDF/);
    }
    const none = checkChatAttachment({ name: 'Makefile', size: 10 });
    assert.equal(none.ok, false);
    if (!none.ok) assert.match(none.message, /without an extension/);
  });

  it('refuses empty files and files over the limit', () => {
    const empty = checkChatAttachment({ name: 'a.txt', size: 0 });
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.code, 'empty');
    assert.equal(checkChatAttachment({ name: 'a.pdf', size: CHAT_ATTACHMENT_MAX_BYTES }).ok, true);
    const big = checkChatAttachment({ name: 'big.pdf', size: CHAT_ATTACHMENT_MAX_BYTES + 1 });
    assert.equal(big.ok, false);
    if (!big.ok) {
      assert.equal(big.code, 'too_large');
      assert.match(big.message, /big\.pdf: 10 MB is over the 10 MB limit/);
    }
  });

  it('accept list matches the allow-list', () => {
    assert.ok(CHAT_ATTACHMENT_ACCEPT.includes('.png'));
    assert.ok(!CHAT_ATTACHMENT_ACCEPT.includes('.exe'));
    assert.ok(!CHAT_ATTACHMENT_ACCEPT.includes('.svg'));
  });
});

describe('CHAT-1 attachmentContentMatches', () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  it('checks magic bytes for images, PDF and Office files', () => {
    assert.equal(attachmentContentMatches('png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), true);
    assert.equal(attachmentContentMatches('png', bytes(0x4d, 0x5a, 0x90, 0)), false);
    assert.equal(attachmentContentMatches('jpg', bytes(0xff, 0xd8, 0xff, 0xe0)), true);
    assert.equal(attachmentContentMatches('pdf', new TextEncoder().encode('%PDF-1.7')), true);
    assert.equal(attachmentContentMatches('pdf', new TextEncoder().encode('hello')), false);
    assert.equal(attachmentContentMatches('docx', bytes(0x50, 0x4b, 0x03, 0x04, 1)), true);
    assert.equal(attachmentContentMatches('xlsx', new TextEncoder().encode('a,b')), false);
    const webp = new Uint8Array([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBP')]);
    assert.equal(attachmentContentMatches('webp', webp), true);
  });
  it('text files must not contain NUL bytes', () => {
    assert.equal(attachmentContentMatches('csv', new TextEncoder().encode('a,b\n1,2')), true);
    assert.equal(attachmentContentMatches('txt', bytes(0x4d, 0x5a, 0x00, 0x01)), false);
    assert.equal(attachmentContentMatches('exe', bytes(1)), false);
  });
});

describe('CHAT-1 attachment naming and message text', () => {
  it('extension, display and stored names', () => {
    assert.equal(attachmentExtension('dir/Report.Final.PDF'), 'pdf');
    assert.equal(attachmentExtension('.env'), '');
    assert.equal(attachmentDisplayName('C:\\Users\\x\\a\u0007b.txt'), 'ab.txt');
    assert.equal(storedAttachmentName('../../my report (v2).pdf', 'pdf'), 'my_report_v2.pdf');
    assert.equal(storedAttachmentName('...pdf', 'pdf'), 'file.pdf');
    assert.equal(storedAttachmentName('résumé.docx', 'docx'), 'resume.docx');
  });

  it('workspace segments are safe path parts', () => {
    assert.equal(workspaceSegment('../etc', 'x'), 'etc');
    assert.equal(workspaceSegment('..', 'x'), 'x');
    assert.equal(workspaceSegment('thread:abc/def', 'x'), 'thread_abc_def');
    for (const seg of [workspaceSegment('a..b', 'x'), workspaceSegment('-a', 'x')]) {
      assert.match(seg, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      assert.ok(!seg.includes('..'));
    }
    assert.equal(chatAttachmentDir('alice', 'thread-1'), 'resources/chat-uploads/alice/thread-1');
    assert.equal(chatAttachmentDir('alice'), 'resources/chat-uploads/alice/new-thread');
  });

  it('formatBytes', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(10 * 1024 * 1024), '10 MB');
  });

  it('messageWithAttachments lists workspace paths after the text', () => {
    assert.equal(messageWithAttachments('  hi  ', []), 'hi');
    const ref = { path: 'resources/chat-uploads/alice/t/x-a.pdf', name: 'a.pdf', size: 2048, mediaType: 'application/pdf' };
    assert.equal(
      messageWithAttachments('Summarise this', [ref]),
      'Summarise this\n\n[Attached files, saved in the company workspace]\n- resources/chat-uploads/alice/t/x-a.pdf (a.pdf, application/pdf, 2 KB)',
    );
    assert.match(messageWithAttachments('', [ref]), /^\[Attached files/);
  });
});
