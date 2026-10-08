/**
 * Agent title validation: non-string → clear error (no silent coercion);
 * trim; empty after trim refused (title required); at most 200 chars after trim
 * (longer refused, never truncated). Covers normalizeAgentTitle, createAgent and
 * updateAgentProfile.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type Row = Record<string, unknown> & {
  id: string;
  companyId: string;
  urlKey: string;
  name: string;
  title: string;
  status: string;
};

let agentRow: Row;
let inserts: Array<Record<string, unknown>>;
let setPayloads: Array<Record<string, unknown>>;
/** What agents.findFirst returns next (null = not found / no duplicate). */
let nextAgentFind: Row | null;

const company = { id: 'company-a', name: 'Company A' };

/** PM's added invisible set (B1), beyond `\s` + U+200B–200D/U+2060/U+FEFF. */
const NEW_INVISIBLES = [
  '\u00AD', '\u180E', '\u200E', '\u200F',
  '\u202A', '\u202B', '\u202C', '\u202D', '\u202E',
  '\u2066', '\u2067', '\u2068', '\u2069',
  '\u3164', '\u2800', '\u061C', '\u115F', '\uFFA0', '\u034F',
];

describe('agent title validation', () => {
  let normalizeAgentTitle: typeof import('./agents').normalizeAgentTitle;
  let AGENT_TITLE_MAX_CHARS: typeof import('./agents').AGENT_TITLE_MAX_CHARS;
  let AgentValidationError: typeof import('./agents').AgentValidationError;
  let createAgent: typeof import('./agents').createAgent;
  let updateAgentProfile: typeof import('./agents').updateAgentProfile;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      const fromAgents = this.filename?.endsWith('/lib/agents.ts');
      if (id === '@tourbillon/db' && fromAgents) {
        return {
          agents: { id: 'id', companyId: 'companyId', urlKey: 'urlKey' },
          companies: { id: 'id' },
          activityLog: {},
          db: {
            query: {
              agents: {
                findFirst: async () => nextAgentFind,
              },
              companies: {
                findFirst: async () => company,
              },
            },
            insert: () => ({
              values: (payload: Record<string, unknown>) => {
                inserts.push(payload);
                return {
                  returning: async () => [
                    {
                      id: 'agent-new',
                      status: 'active',
                      companyId: company.id,
                      ...payload,
                    } as Row,
                  ],
                };
              },
            }),
            update: () => ({
              set: (payload: Record<string, unknown>) => {
                setPayloads.push(payload);
                return {
                  where: () => ({
                    returning: async () => {
                      agentRow = { ...agentRow, ...payload } as Row;
                      return [agentRow];
                    },
                  }),
                };
              },
            }),
          },
        };
      }
      if (id === 'drizzle-orm' && fromAgents) {
        return { eq: () => ({}), and: () => ({}) };
      }
      if (id === '@tourbillon/mastra' && fromAgents) {
        return { clearIdleThreadOnRuntimeSwitch: async () => {} };
      }
      if ((id === './chat' || id === './llm-providers' || id === './company') && fromAgents) {
        return {
          invalidateChatControllerForAgent: () => {},
          getDefaultLlmProviderRecord: async () => null,
          getActiveCompany: async () => company,
        };
      }
      if (id === '@tourbillon/shared/company-workspace' && fromAgents) {
        return {
          seedAgentSkillsFromTemplates: async () => {},
          buildAssignedSkills: async () => [],
          copyAgentWorkspaceSkills: async () => {},
          discoverCompanySkillSlugs: async () => [],
        };
      }
      if (id === './code-execution-config' && fromAgents) {
        return {
          applyCodeExecutionOverrides: () => ({}),
          buildCodeExecutionActivityDetails: () => ({}),
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };

    ({
      normalizeAgentTitle,
      AGENT_TITLE_MAX_CHARS,
      AgentValidationError,
      createAgent,
      updateAgentProfile,
    } = await import('./agents'));
  });

  beforeEach(() => {
    agentRow = {
      id: 'agent-1',
      companyId: 'company-a',
      urlKey: 'alice',
      name: 'Alice',
      title: 'CEO',
      status: 'active',
    };
    nextAgentFind = agentRow;
    inserts = [];
    setPayloads = [];
  });

  describe('normalizeAgentTitle', () => {
    it('refuses non-string values (no silent coercion)', () => {
      for (const raw of [42, 0, true, false, { a: 1 }, ['x'], [], {}]) {
        assert.throws(() => normalizeAgentTitle(raw), {
          name: 'AgentValidationError',
          message: 'Title must be a string.',
        });
      }
    });

    it('missing (null / undefined) → Title is required (same as before)', () => {
      for (const raw of [null, undefined]) {
        assert.throws(() => normalizeAgentTitle(raw), {
          name: 'AgentValidationError',
          message: 'Title is required.',
        });
      }
    });

    it('refuses empty / whitespace-only / zero-width-only after edge-blank trim', () => {
      for (const raw of ['', '   ', '\n\t', '  \n  ', '\u200B', '\u200B\u200C\u200D\u2060\uFEFF', '  \u200B  ']) {
        assert.throws(() => normalizeAgentTitle(raw), {
          name: 'AgentValidationError',
          message: 'Title is required.',
        });
      }
    });

    it('edge-blank trims zero-width at the edges and accepts the middle', () => {
      assert.equal(normalizeAgentTitle('  \u200BChief Technology Officer\uFEFF\n'), 'Chief Technology Officer');
    });

    it('B1: refuses a title made only of the new invisible set (alone, mixed, with spaces)', () => {
      const cases = [...NEW_INVISIBLES, ...NEW_INVISIBLES.map((c) => ` ${c} ${c} `), NEW_INVISIBLES.join(''), NEW_INVISIBLES.join(' ')];
      for (const raw of cases) {
        assert.throws(() => normalizeAgentTitle(raw), {
          name: 'AgentValidationError',
          message: 'Title is required.',
        }, JSON.stringify(raw));
      }
    });

    it('B1: trims the new invisible set from the edges', () => {
      for (const ch of NEW_INVISIBLES) {
        assert.equal(normalizeAgentTitle(`${ch} CTO ${ch}`), 'CTO', JSON.stringify(ch));
      }
    });

    it('keeps a U+200B in the middle of a real title (edge trim only)', () => {
      assert.equal(normalizeAgentTitle('Chief\u200BOfficer'), 'Chief\u200BOfficer');
      assert.equal(normalizeAgentTitle('\u200E Chief\u200BOfficer \u200B'), 'Chief\u200BOfficer');
    });

    it('S2: unchanged blank / invisible-only current title is not re-validated', () => {
      for (const current of ['', '   ', '\u200B', '\u3164', ' \u202E\u2069 ']) {
        for (const raw of ['', '  ', '\u200B', '\u00AD\u2800', current]) {
          assert.equal(normalizeAgentTitle(raw, { currentTitle: current }), current, JSON.stringify([raw, current]));
        }
      }
    });

    it('S2: a blank incoming title against a real current title is still required', () => {
      for (const raw of ['', '   ', '\u200E', '\uFFA0 \u115F']) {
        assert.throws(() => normalizeAgentTitle(raw, { currentTitle: 'CEO' }), {
          name: 'AgentValidationError',
          message: 'Title is required.',
        });
      }
    });

    it('S3: same-length different over-cap title is refused (equality is by content)', () => {
      const current = 'L'.repeat(250);
      assert.throws(() => normalizeAgentTitle('M'.repeat(250), { currentTitle: current }), {
        name: 'AgentValidationError',
        message: 'Title must be at most 200 characters.',
      });
    });

    it('S2/S3: compares against the trimmed current title', () => {
      const current = ` \u200B${'L'.repeat(250)}\u2069 `;
      assert.equal(normalizeAgentTitle('L'.repeat(250), { currentTitle: current }), current);
      assert.equal(normalizeAgentTitle('', { currentTitle: ' \u200B\u3164 ' }), ' \u200B\u3164 ');
    });

    it('trims and accepts a normal title', () => {
      assert.equal(normalizeAgentTitle('  Chief Technology Officer  '), 'Chief Technology Officer');
    });

    it('accepts exactly 200 characters after trim', () => {
      const ok = 'x'.repeat(AGENT_TITLE_MAX_CHARS);
      assert.equal(normalizeAgentTitle(`  ${ok}  `), ok);
      assert.equal(ok.length, 200);
    });

    it('refuses over 200 characters after trim (does not truncate)', () => {
      const over = 'y'.repeat(AGENT_TITLE_MAX_CHARS + 1);
      assert.throws(() => normalizeAgentTitle(over), {
        name: 'AgentValidationError',
        message: 'Title must be at most 200 characters.',
      });
    });
  });

  describe('createAgent title', () => {
    it('non-string title → AgentValidationError before insert', async () => {
      nextAgentFind = null;
      for (const title of [42, true, { t: 1 }, ['CEO'], null]) {
        const expected = title === null ? 'Title is required.' : 'Title must be a string.';
        await assert.rejects(
          () => createAgent({ name: 'Bob', title, role: 'engineer' }),
          (err: unknown) => {
            assert.ok(err instanceof AgentValidationError);
            assert.equal((err as Error).message, expected);
            return true;
          },
        );
      }
      assert.equal(inserts.length, 0);
    });

    it('over 200 → refused; exactly 200 and trimmed → accepted', async () => {
      nextAgentFind = null;
      await assert.rejects(
        () =>
          createAgent({
            name: 'Bob',
            title: 'z'.repeat(201),
            role: 'engineer',
            urlKey: 'bob-long',
          }),
        { name: 'AgentValidationError', message: 'Title must be at most 200 characters.' },
      );
      assert.equal(inserts.length, 0);

      const title200 = 'a'.repeat(200);
      const created = await createAgent({
        name: 'Bob',
        title: `  ${title200}  `,
        role: 'engineer',
        urlKey: 'bob-ok',
      });
      assert.equal(created.title, title200);
      assert.equal(inserts.length, 1);
      assert.equal(inserts[0].title, title200);
    });

    it('empty title after trim → Title is required', async () => {
      nextAgentFind = null;
      await assert.rejects(
        () => createAgent({ name: 'Bob', title: '   ', role: 'engineer' }),
        { name: 'AgentValidationError', message: 'Title is required.' },
      );
      assert.equal(inserts.length, 0);
    });

    it('B1: invisible-only title → Title is required before insert', async () => {
      nextAgentFind = null;
      for (const title of NEW_INVISIBLES) {
        await assert.rejects(
          () => createAgent({ name: 'Bob', title: ` ${title} `, role: 'engineer' }),
          { name: 'AgentValidationError', message: 'Title is required.' },
        );
      }
      assert.equal(inserts.length, 0);
    });
  });

  describe('updateAgentProfile title', () => {
    it('B1: invisible-only title → Title is required, no write', async () => {
      for (const title of ['\u200E\u200F', ' \u00AD ', '\u3164', '\u2800\u202A', '\u061C\u034F']) {
        nextAgentFind = agentRow;
        await assert.rejects(
          () => updateAgentProfile('agent-1', { name: 'Alice', title, urlKey: 'alice' }),
          { name: 'AgentValidationError', message: 'Title is required.' },
        );
      }
      assert.equal(setPayloads.length, 0);
    });

    it('S3: stored 250×L, send 250×M → refused (not a same-length match)', async () => {
      agentRow = { ...agentRow, title: 'L'.repeat(250) };
      nextAgentFind = agentRow;
      await assert.rejects(
        () => updateAgentProfile('agent-1', { name: 'Alice', title: 'M'.repeat(250), urlKey: 'alice' }),
        { name: 'AgentValidationError', message: 'Title must be at most 200 characters.' },
      );
      assert.equal(setPayloads.length, 0);
    });

    it('stored title with edge blanks: compared trimmed; a different real title replaces it trimmed', async () => {
      const stored = ` \u200B${'L'.repeat(250)}\u202C\n`;
      agentRow = { ...agentRow, title: stored };
      nextAgentFind = agentRow;
      const same = await updateAgentProfile('agent-1', { name: 'Alice', title: 'L'.repeat(250), urlKey: 'alice' });
      assert.equal(same.title, stored);
      assert.equal(setPayloads[0].title, stored);

      setPayloads = [];
      agentRow = { ...agentRow, title: '  \u200ECTO\uFEFF ' };
      nextAgentFind = agentRow;
      const changed = await updateAgentProfile('agent-1', { name: 'Alice', title: '\u2066Chief\u200BOfficer\u2069', urlKey: 'alice' });
      assert.equal(changed.title, 'Chief\u200BOfficer');
      assert.equal(setPayloads[0].title, 'Chief\u200BOfficer');
    });

    it('S2: legacy blank / zero-width stored title does not block a name-only save', async () => {
      for (const stored of ['', '   ', '\u200B', '\u3164\u2800']) {
        for (const title of [stored, '', '\u200B']) {
          setPayloads = [];
          agentRow = { ...agentRow, title: stored, name: 'Alice' };
          nextAgentFind = agentRow;
          const updated = await updateAgentProfile('agent-1', { name: 'Alice Renamed', title, urlKey: 'alice' });
          assert.equal(updated.name, 'Alice Renamed', JSON.stringify([stored, title]));
          assert.equal(setPayloads[0].title, stored);
        }
      }
    });

    it('non-string title → AgentValidationError, no write', async () => {
      for (const title of [99, false, { x: 1 }, ['CTO'], null]) {
        nextAgentFind = agentRow;
        const expected = title === null ? 'Title is required.' : 'Title must be a string.';
        await assert.rejects(
          () =>
            updateAgentProfile('agent-1', {
              name: 'Alice',
              title,
              urlKey: 'alice',
            }),
          { name: 'AgentValidationError', message: expected },
        );
      }
      assert.equal(setPayloads.length, 0);
    });

    it('over 200 refused; exactly 200 and trimmed accepted', async () => {
      await assert.rejects(
        () =>
          updateAgentProfile('agent-1', {
            name: 'Alice',
            title: 'q'.repeat(201),
            urlKey: 'alice',
          }),
        { name: 'AgentValidationError', message: 'Title must be at most 200 characters.' },
      );
      assert.equal(setPayloads.length, 0);

      const title200 = 'b'.repeat(200);
      const updated = await updateAgentProfile('agent-1', {
        name: 'Alice',
        title: ` \n${title200}\t `,
        urlKey: 'alice',
      });
      assert.equal(updated.title, title200);
      assert.equal(setPayloads.length, 1);
      assert.equal(setPayloads[0].title, title200);
    });

    it('empty / zero-width-only title → Title is required (dashboard/REST)', async () => {
      for (const title of ['  ', '\u200B\u200C', ' \uFEFF ']) {
        setPayloads = [];
        await assert.rejects(
          () =>
            updateAgentProfile('agent-1', {
              name: 'Alice',
              title,
              urlKey: 'alice',
            }),
          { name: 'AgentValidationError', message: 'Title is required.' },
        );
        assert.equal(setPayloads.length, 0);
      }
    });

    it('S3: unchanged over-cap title does not block a name-only save', async () => {
      const legacy = 'L'.repeat(AGENT_TITLE_MAX_CHARS + 50);
      agentRow = { ...agentRow, title: legacy };
      nextAgentFind = agentRow;
      const updated = await updateAgentProfile('agent-1', {
        name: 'Alice Renamed',
        title: legacy,
        urlKey: 'alice',
      });
      assert.equal(updated.name, 'Alice Renamed');
      assert.equal(updated.title, legacy);
      assert.equal(setPayloads.length, 1);
      assert.equal(setPayloads[0].title, legacy);

      // Same content after edge-blank trim (extra ZWSP edges) still counts as unchanged.
      setPayloads = [];
      agentRow = { ...agentRow, title: legacy, name: 'Alice Renamed' };
      nextAgentFind = agentRow;
      const again = await updateAgentProfile('agent-1', {
        name: 'Alice Renamed',
        title: `\u200B${legacy}\uFEFF`,
        urlKey: 'alice',
      });
      assert.equal(again.title, legacy);
      assert.equal(setPayloads[0].title, legacy);
    });

    it('S3: changing to a different over-cap title is still refused', async () => {
      const legacy = 'L'.repeat(AGENT_TITLE_MAX_CHARS + 50);
      agentRow = { ...agentRow, title: legacy };
      nextAgentFind = agentRow;
      await assert.rejects(
        () =>
          updateAgentProfile('agent-1', {
            name: 'Alice',
            title: 'N'.repeat(AGENT_TITLE_MAX_CHARS + 1),
            urlKey: 'alice',
          }),
        { name: 'AgentValidationError', message: 'Title must be at most 200 characters.' },
      );
      assert.equal(setPayloads.length, 0);
    });
  });
});
