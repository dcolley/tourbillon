/**
 * `company-computer` Tier-2 toolset (Slice 1).
 *
 * S282-S4: lives in @tourbillon/mastra (not @tourbillon/company-computer) so the
 * workspace dep graph is one-way — company-computer is a leaf with no mastra edge.
 *
 * Two gates (locked product rule): company `hasComputer === true` AND agent
 * `hasComputer === true`. The toolset being attached never bypasses them — the
 * /api/internal/company-computer/* routes re-check both flags server-side on every
 * call, so these tools surface the gate errors verbatim.
 *
 * Slice 1 implements openBrowser, screenshot, click, typeText, closeSession,
 * getSessionInfo end-to-end against the API. openFileManager / openTerminal /
 * pressKey / mouseMove / scroll are explicit stubs (out of scope until Slice 2+).
 *
 * S282-S7: Board watch/takeover (and any `{ paused: true }` input result) is Slice 2.
 * Descriptions here must not promise it; the tools.test pin enforces that.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { tracedAgentFetch } from './api-client';

const BASE = '/api/internal/company-computer';

async function call(action: string, requestContext: unknown, body?: unknown): Promise<unknown> {
  const res = await tracedAgentFetch(`computer:${action}`, requestContext, `${BASE}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
  return res.json();
}

const urlSchema = z
  .string()
  .url('url must be an absolute http(s) URL')
  .refine((u) => /^https?:\/\//.test(u), 'only http(s) URLs are allowed')
  .optional();

export const computerOpenBrowserTool = createTool({
  id: 'computerOpenBrowser',
  description:
    'Open a URL in the agent\'s Company Computer browser (per-agent desktop seat). Creates the seat if none exists. ' +
    'Requires company Computer enabled AND agent hasComputer enabled; otherwise returns a clear gate error. ' +
    'Use computerScreenshot afterwards to read the rendered page.',
  inputSchema: z.object({
    url: urlSchema.describe('Absolute http(s) URL to open. Omit to just ensure the seat is up.'),
  }),
  execute: async (inputData, { requestContext }) => call('openBrowser', requestContext, inputData),
});

export const computerScreenshotTool = createTool({
  id: 'computerScreenshot',
  description:
    'Capture the agent\'s Company Computer desktop as a base64 PNG. Read rendered pages, verify clicks. ' +
    'Returns { imageBase64, width, height }.',
  inputSchema: z.object({}),
  execute: async (_inputData, { requestContext }) => call('screenshot', requestContext),
});

export const computerClickTool = createTool({
  id: 'computerClick',
  description:
    'Click at absolute pixel coordinates (0,0 = top-left) on the agent\'s Company Computer desktop. ' +
    'Verify the result with computerScreenshot.',
  inputSchema: z.object({
    x: z.number().int().min(0).describe('X pixel coordinate'),
    y: z.number().int().min(0).describe('Y pixel coordinate'),
    button: z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button'),
  }),
  execute: async (inputData, { requestContext }) => call('click', requestContext, inputData),
});

export const computerTypeTextTool = createTool({
  id: 'computerTypeText',
  description:
    'Type text into the focused window of the agent\'s Company Computer desktop. ' +
    'NEVER type passwords, API keys, 2FA codes or other secrets — comment on the issue and ask the Board to handle credential entry.',
  inputSchema: z.object({
    text: z.string().min(1).max(4096).describe('Text to type into the focused window'),
  }),
  execute: async (inputData, { requestContext }) => call('typeText', requestContext, inputData),
});

export const computerCloseSessionTool = createTool({
  id: 'computerCloseSession',
  description:
    'Destroy the agent\'s Company Computer seat (container + session row). Call when finished with GUI work to free resources. ' +
    'The seat can be recreated later; the agent home directory persists on the host.',
  inputSchema: z.object({}),
  execute: async (_inputData, { requestContext }) => call('destroySession', requestContext),
});

export const computerGetSessionInfoTool = createTool({
  id: 'computerGetSessionInfo',
  description:
    'Read the agent\'s current Company Computer seat: status, container name, VNC port, timestamps. ' +
    'Use to confirm the seat is running before driving input. (Board watch/takeover is Slice 2 — not available yet.)',
  inputSchema: z.object({}),
  execute: async (_inputData, { requestContext }) => call('getSession', requestContext),
});
/** Slice-2+ stubs — registered so the agent sees a clear not_implemented, not a missing tool. */
function stubTool(id: string, description: string, schema: z.ZodTypeAny) {
  return createTool({
    id,
    description: description + ' NOT_IMPLEMENTED yet (Slice 2+): calling it returns { error: "not_implemented" }.',
    inputSchema: schema,
    execute: async () => ({
      error: 'not_implemented',
      message: `${id} is not available in Slice 1. Use browser tools or the code-execution sandbox meanwhile.`,
    }),
  });
}

export const computerOpenFileManagerTool = stubTool(
  'computerOpenFileManager',
  'Open the file manager GUI on the Company Computer desktop at an optional path.',
  z.object({ path: z.string().optional() }),
);
export const computerOpenTerminalTool = stubTool(
  'computerOpenTerminal',
  'Open a terminal emulator on the Company Computer desktop.',
  z.object({ cwd: z.string().optional() }),
);
export const computerPressKeyTool = stubTool(
  'computerPressKey',
  'Press a special key (Enter, Tab, Escape) with optional modifiers.',
  z.object({ key: z.string(), modifiers: z.array(z.string()).optional() }),
);
export const computerMouseMoveTool = stubTool(
  'computerMouseMove',
  'Move the mouse without clicking.',
  z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }),
);
export const computerScrollTool = stubTool(
  'computerScroll',
  'Scroll the focused window.',
  z.object({ direction: z.enum(['up', 'down']), amount: z.number().int().positive().optional() }),
);

/** ROLE_TOOLS entry — attached only when the agent holds the `company-computer` toolset. */
export const COMPANY_COMPUTER_TOOLS: Record<string, unknown> = {
  computerOpenBrowserTool,
  computerScreenshotTool,
  computerClickTool,
  computerTypeTextTool,
  computerCloseSessionTool,
  computerGetSessionInfoTool,
  computerOpenFileManagerTool,
  computerOpenTerminalTool,
  computerPressKeyTool,
  computerMouseMoveTool,
  computerScrollTool,
};
