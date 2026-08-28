import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentController } from '@mastra/core/agent-controller';
import { Agent } from '@mastra/core/agent';
import { createOpenAI } from '@ai-sdk/openai';

/**
 * HOLD 2: Prove session.abort() clears displayState.isRunning (Mastra 1.63+)
 * 
 * #24 required Stop to clear a false working state when abort() left isRunning true.
 * This test FAILS if abort() doesn't clear isRunning.
 * 
 * Uses REAL Mastra Session with streaming mock that sets isRunning: true.
 */
describe('Session.abort() clears running state (Mastra 1.63)', () => {
  it('abort() during sendMessage clears isRunning from true to false', async () => {
    // Mock fetch to return a slow streaming response (keeps session running)
    const originalFetch = globalThis.fetch;
    let streamController: ReadableStreamDefaultController | null = null;
    
    globalThis.fetch = async (url: any, init?: any) => {
      if (typeof url === 'string' && url.includes('/chat/completions')) {
        // Return a streaming response that never finishes (until aborted)
        const stream = new ReadableStream({
          start(controller) {
            streamController = controller;
            // Send SSE prefix but don't close - keeps session running
            const chunk = 'data: {"id":"test","object":"chat.completion.chunk","created":1234567890,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n';
            controller.enqueue(new TextEncoder().encode(chunk));
          },
        });
        
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }) as any;
      }
      return originalFetch(url as any, init);
    };
    
    try {
      const testProvider = createOpenAI({
        apiKey: 'test-key',
        baseURL: 'http://fake-test.local/v1',
      });
      
      const agent = new Agent({
        id: 'test-agent',
        name: 'Test Agent',
        instructions: 'Test agent',
        model: testProvider.chat('test-model'),
        tools: {},
      });
      
      const controller = new AgentController({
        id: 'test-controller',
        resourceId: 'test-resource',
        agent,
        modes: [{ id: 'test-mode', name: 'Test Mode' }],
      });
      
      const session = await controller.createSession({
        resourceId: 'test-resource',
        id: 'test-thread',
        ownerId: 'test-controller',
      });
      
      // Start sendMessage (sets isRunning: true while streaming)
      const messagePromise = session.sendMessage({ role: 'user', content: 'test' });
      
      // Wait for stream to start and isRunning to become true
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const displayStateDuringStream = session.displayState.get();
      
      // KEY ASSERTION: isRunning should be true during active sendMessage
      // This FAILS if Mastra doesn't set isRunning during stream
      assert.equal(
        displayStateDuringStream.isRunning,
        true,
        'isRunning must be true during active sendMessage stream'
      );
      
      // Now abort (as the route does)
      session.abort();
      
      // Clean up stream
      streamController?.close();
      await messagePromise.catch(() => {}); // Swallow abort error
      
      const displayStateAfterAbort = session.displayState.get();
      
      // KEY ASSERTION: abort() must clear isRunning to false
      // This FAILS if abort() doesn't clear running state
      assert.equal(
        displayStateAfterAbort.isRunning,
        false,
        'abort() must clear isRunning to false (HOLD 2 requirement)'
      );
      
      // Also verify displayState.set() doesn't exist (read-only in 1.63+)
      assert.equal(
        'set' in session.displayState,
        false,
        'displayState.set should not exist in Mastra 1.63+ (read-only)'
      );
      
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  
  it('documents displayState is read-only and abort() is the force-clear', async () => {
    // In Mastra <1.63, we could force-clear with:
    //   session.displayState.set({ ...displayState, isRunning: false })
    // 
    // In Mastra 1.63+:
    // - displayState.set() is removed (read-only via .get())
    // - session.abort() does the force-clear internally
    // - abort() emits agent_end event with isRunning: false
    // - No manual state manipulation needed or possible
    
    const testProvider = createOpenAI({
      apiKey: 'test-key',
      baseURL: 'http://localhost:1234/v1',
    });
    
    const agent = new Agent({
      id: 'test-agent',
      name: 'Test',
      instructions: 'Test',
      model: testProvider.chat('test-model'),
      tools: {},
    });
    
    const controller = new AgentController({
      id: 'test-controller',
      resourceId: 'test-resource',
      agent,
      modes: [{ id: 'test', name: 'Test' }],
    });
    
    const session = await controller.createSession({
      resourceId: 'test-resource',
      id: 'test-thread',
      ownerId: 'test-controller',
    });
    
    // Verify: displayState.set() does not exist (read-only)
    assert.equal(
      'set' in session.displayState,
      false,
      'displayState.set should not exist in Mastra 1.63+ (read-only)'
    );
    
    // Verify: abort() exists as the replacement mechanism
    assert.equal(
      typeof session.abort,
      'function',
      'session.abort() must exist as the force-clear mechanism'
    );
    
    // Verify: displayState.get() is callable (read access)
    const state = session.displayState.get();
    assert.ok(state !== undefined, 'displayState.get() must return state object');
  });
});
