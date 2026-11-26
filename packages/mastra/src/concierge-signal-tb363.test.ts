1|/**
2| * TB-363 A2 — the stored needs-input line must tell the human HOW to answer (reply in this
3| * thread resumes the task), and must still relay the stated ask verbatim (#340 contract).
4| * The stored signal contents ARE the visible notice text (TB-363 R1 renders them directly),
5| * so this is display-critical, not just model guidance.
6| */
7|import { test } from 'node:test';
8|import assert from 'node:assert/strict';
9|import { taskProgressSignalPayload, persistConciergeSignal, queueConciergeSignal } from './concierge-signal';
10|
11|const base = {
12|  companyId: 'company-1',
13|  agentId: 'agent-1',
14|  chatTaskId: 'task-1',
15|  runId: 'run-1',
16|  status: 'succeeded' as const,
17|  title: 'Vendor call',
18|};
19|
20|test('A2: waiting_on_user payload keeps the exact ask and says the human can reply here', () => {
21|  const payload = taskProgressSignalPayload({ ...base, stage: 'waiting_on_user', detail: 'Pick vendor A or B' });
22|  assert.match(payload.contents, /is waiting on the human: Pick vendor A or B/, 'full ask survives (never a generic "needs input")');
23|  assert.match(payload.contents, /reply here/, 'tells the human where to answer (M9: detail not dropped in the payload)');
24|  assert.match(payload.contents, /status pending/, 'states the resume contract (#340)');
25|});
26|
27|test('A2: no detail -> no invented ask (still says reply here)', () => {
28|  const payload = taskProgressSignalPayload({ ...base, stage: 'waiting_on_user' });
29|  assert.match(payload.contents, /is waiting on the human\./);
30|  assert.match(payload.contents, /reply here/);
31|  assert.doesNotMatch(payload.contents, /Pick vendor/, 'nothing is invented');
32|});
33|
34|test('MUST-4: persistConciergeSignal requests ifIdle.behavior=persist and resolves even when persisted never settles', async () => {
35|  // CONT3 root cause pinned: Mastra settles the idle-persist `persisted` handle only when
36|  // its broadcast stream is consumed — awaiting it hangs the bridge forever. The call must
37|  // resolve on `accepted` alone. (This test TIMES OUT if anyone re-adds an await.)
38|  const calls: Array<{ signal: { id?: string }; target: Record<string, unknown> }> = [];
39|  const neverSettled = new Promise<void>(() => {});
40|  const agent = {
41|    sendSignal(signal: { id?: string }, target: Record<string, unknown>) {
42|      calls.push({ signal, target });
43|      return { signal: { id: signal.id }, accepted: Promise.resolve({ action: 'persist' }), persisted: neverSettled };
44|    },
45|  };
46|  const payload = taskProgressSignalPayload({ ...base, stage: 'started', status: 'running' });
47|  const settled = await persistConciergeSignal(agent as never, { resourceId: 'r1', threadId: 't1' }, payload);
48|  assert.equal(calls.length, 1, 'exactly one Agent-level sendSignal');
49|  const t = calls[0]!.target as { resourceId?: string; threadId?: string; ifIdle?: { behavior?: string } };
50|  assert.equal(t.resourceId, 'r1');
51|  assert.equal(t.threadId, 't1');
52|  assert.equal(t.ifIdle?.behavior, 'persist', 'no-wake policy rides as ifIdle.behavior=persist (Session drops it — the Agent-level call is the only seam)');
53|  // MUST-6: ifActive MUST also be persist — Mastra's default 'deliver' queues the signal INTO
54|  // the in-flight same-agent run (mid-turn second reply) or returns 'blocked' cross-agent.
55|  assert.equal(
56|    (t as { ifActive?: { behavior?: string } }).ifActive?.behavior,
57|    'persist',
58|    'busy-origin no-wake policy rides as ifActive.behavior=persist (default deliver would drain mid-turn / block cross-agent)',
59|  );
60|  assert.equal(settled.action, 'persist');
61|});
62|
63|// TB-363 MUST-7 (PM N-3): the covered go-between is a TRANSIENT wake — the session queue
64|// carries the flag so Mastra's persistence filters (filter-messages-for-persistence) skip
65|// storing it: the reply's content item renders from the run, no second notice row.
66|test('queueConciergeSignal passes transient:true through to Session.queueSignal (MUST-7)', async () => {
67|  const seen: Array<Record<string, unknown>> = [];
68|  const session = {
69|    queueSignal: (signal: Record<string, unknown>) => {
70|      seen.push(signal);
71|      return Promise.resolve();
72|    },
73|  };
74|  const payload = taskProgressSignalPayload({
75|    companyId: 'c1',
76|    agentId: 'a1',
77|    chatTaskId: 't1',
78|    runId: 'r1',
79|    stage: 'waiting_on_user',
80|    status: 'succeeded',
81|    title: 'Deploy staging',
82|    detail: 'ask: prod or staging?',
83|  });
84|  await queueConciergeSignal(session as never, {
85|    tagName: payload.tagName,
86|    attributes: payload.attributes,
87|    contents: payload.contents,
88|    transient: true,
89|  });
90|  assert.equal(seen.length, 1);
91|  assert.equal(seen[0]!.transient, true, 'the go-between signal must be transient (no stored row)');
92|  assert.equal(seen[0]!.tagName, 'task-progress', 'delivered with the task-progress tag/shape');
93|  // A plain (non-transient) queue never sets the flag — normal wakes keep storing their row.
94|  await queueConciergeSignal(session as never, {
95|    tagName: payload.tagName,
96|    attributes: payload.attributes,
97|    contents: payload.contents,
98|  });
99|  assert.ok(!('transient' in seen[1]!) || seen[1]!.transient !== true, 'default wakes stay persistent');
100|});
101|
102|// TB-363 MUST-6 (M21a killer): the persist call must carry BOTH policies. Mastra defaults
// ifActive to 'deliver' (agent-DtdQ6un6.js #sendSignal: activeBehavior = target.ifActive?.behavior
// ?? \"deliver\"), which queues the signal INTO a blocking run. NOTE (red-on-base evidence,
// RESULT): Mastra's active-run state is INSTANCE-LOCAL (state.activeThreadRunIds /
// threadRunsById, agent-DtdQ6un6.js:40154/40562), so a TN cell that holds the run on the
// chat-controller's Agent cannot observe the registry-side persist Agent ever being 'active'
// — this unit contract, not the TN cell, is what kills dropping the ifActive argument.
test('MUST-6: persistConciergeSignal sends ifIdle persist AND ifActive persist', async () => {
  const targets: Array<Record<string, unknown>> = [];
  const agent = {
    sendSignal: (_signal: unknown, target: Record<string, unknown>) => {
      targets.push(target);
      return { signal: { id: 'sig-c6' }, accepted: Promise.resolve({ action: 'persist' }) };
    },
  };
  const payload = taskProgressSignalPayload({ ...base, stage: 'waiting_on_user', detail: 'ask: prod or staging?' });
  const settled = await persistConciergeSignal(agent as never, { resourceId: 'res-9', threadId: 'th_9' }, payload);
  assert.equal(settled.action, 'persist');
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0]!.ifIdle, { behavior: 'persist' }, 'idle persists');
  assert.deepEqual(targets[0]!.ifActive, { behavior: 'persist' }, 'active persists too — never the deliver default');
  assert.equal(targets[0]!.threadId, 'th_9');
  assert.equal(targets[0]!.resourceId, 'res-9');
});

test('MUST-4: a rejected persisted handle never rejects the persist call (no unhandled crash)', async () => {
103|  const agent = {
104|    sendSignal(signal: { id?: string }, _target: Record<string, unknown>) {
105|      return {
106|        signal: { id: signal.id },
107|        accepted: Promise.resolve({ action: 'persist' }),
108|        persisted: Promise.reject(new Error('memory write failed')),
109|      };
110|    },
111|  };
112|  const payload = taskProgressSignalPayload({ ...base, stage: 'done', status: 'succeeded' });
113|  const settled = await persistConciergeSignal(agent as never, { resourceId: 'r1', threadId: 't1' }, payload);
114|  assert.equal(settled.action, 'persist');
115|});