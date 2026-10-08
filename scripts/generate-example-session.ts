/**
 * Regenerates examples/session.jsonl and examples/session.trimmed.jsonl: a
 * small made-up session, and what trimTranscript actually does to it, so the
 * README's before/after numbers stay real.
 *
 *   npm run gen-example
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { trimTranscript } from '../src/trim.js';
import { parseTranscript } from '../src/transcript.js';

const rateLimiterSrc = `import { Clock } from "./clock";

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly clock: Clock = new Clock(),
  ) {
    this.tokens = capacity;
    this.lastRefill = clock.now();
  }

  /** Consumes \`cost\` tokens if available; refills based on elapsed time first. */
  tryAcquire(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
  }

  /** Current token count, for metrics and tests. Rounds down so callers never see a false positive. */
  availableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /** Resets the bucket to full capacity, e.g. after a config reload. */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefill = this.clock.now();
  }
}
`;

const testFailure = `FAIL src/rateLimiter.test.ts > RateLimiter > refuses once capacity is spent
AssertionError: expected true to be false
 ❯ src/rateLimiter.test.ts:41:23
    39|   for (let i = 0; i < 10; i++) limiter.tryAcquire();
    40|   clock.advance(1); // 1 real second, but refill() divides by 1000ms twice
  > 41|   expect(limiter.tryAcquire()).toBe(false);
    42| });
    43|

 ❯ src/rateLimiter.test.ts:52:23
    50|   const limiter = new RateLimiter(5, 1, clock);
    51|   clock.advance(5000);
  > 52|   expect(limiter.availableTokens()).toBe(5);
    53| });

Expected: false
Received: true

Test Files  1 failed (1)
     Tests  2 failed | 6 passed (8)
  Start at  14:02:11
  Duration  412ms
`;

const testPass = `✓ src/rateLimiter.test.ts (8 tests) 9ms
  ✓ RateLimiter > starts at full capacity
  ✓ RateLimiter > spends a token per call
  ✓ RateLimiter > refuses once capacity is spent
  ✓ RateLimiter > refills gradually over real time
  ✓ RateLimiter > refill never exceeds capacity
  ✓ RateLimiter > availableTokens rounds down
  ✓ RateLimiter > reset returns to full capacity
  ✓ RateLimiter > reset clears a pending partial refill

Test Files  1 passed (1)
     Tests  8 passed (8)
  Start at  14:04:52
  Duration  11ms
`;

const testFileSrc = `import { describe, it, expect } from "vitest";
import { RateLimiter } from "./rateLimiter";
import { FakeClock } from "./testUtil/fakeClock";

describe("RateLimiter", () => {
  it("starts at full capacity", () => {
    const limiter = new RateLimiter(5, 1, new FakeClock());
    expect(limiter.availableTokens()).toBe(5);
  });

  it("spends a token per call", () => {
    const limiter = new RateLimiter(5, 1, new FakeClock());
    limiter.tryAcquire();
    expect(limiter.availableTokens()).toBe(4);
  });
});
`;

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: 'tool_use', id, name, input };
}
function toolResult(id: string, content: string, isError = false) {
  return { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) };
}

const lines: unknown[] = [
  { type: 'summary', summary: 'Fix rate limiter refill bug' },
  { type: 'user', message: { role: 'user', content: 'The RateLimiter in src/rateLimiter.ts is letting through more requests than it should under load. Can you find and fix the bug?' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "Let me look at the rate limiter first." }, toolUse('t1', 'Read', { file_path: 'src/rateLimiter.ts' })] } },
  { type: 'user', message: { role: 'user', content: [toolResult('t1', rateLimiterSrc)] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "I'll run the tests to see the current failure before changing anything." }, toolUse('t2', 'Bash', { command: 'npm test -- rateLimiter' })] } },
  { type: 'user', message: { role: 'user', content: [toolResult('t2', testFailure, true)] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "Found it: refill() divides the elapsed time by 1000 to get seconds, but under real load the clock returns milliseconds, so refill was 1000x too fast. Fixing the unit conversion." }, toolUse('t3', 'Edit', { file_path: 'src/rateLimiter.ts', old_string: '  private refill(): void {\n    const now = this.clock.now();\n    const elapsed = (now - this.lastRefill) / 1000;\n    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);\n    this.lastRefill = now;\n  }', new_string: '  private refill(): void {\n    const now = this.clock.now();\n    const elapsedMs = now - this.lastRefill;\n    const elapsedSeconds = elapsedMs / 1000;\n    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);\n    this.lastRefill = now;\n  }' })] } },
  { type: 'user', message: { role: 'user', content: [toolResult('t3', 'The file src/rateLimiter.ts has been updated.')] } },
  { type: 'assistant', message: { role: 'assistant', content: [toolUse('t4', 'Bash', { command: 'npm test -- rateLimiter' })] } },
  { type: 'user', message: { role: 'user', content: [toolResult('t4', testPass)] } },
  { type: 'assistant', message: { role: 'assistant', content: "Fixed. elapsed was already treated as seconds but came from a millisecond clock. All 8 tests pass now." } },
  { type: 'user', message: { role: 'user', content: 'Thanks. Can you also show me the test file so I can add a burst-traffic case?' } },
  { type: 'assistant', message: { role: 'assistant', content: [toolUse('t5', 'Read', { file_path: 'src/rateLimiter.test.ts' })] } },
  { type: 'user', message: { role: 'user', content: [toolResult('t5', testFileSrc)] } },
  { type: 'assistant', message: { role: 'assistant', content: "Sure, here it is above. I'll add a test that spends exactly the capacity in a burst, then checks the next call is refused." } },
];

mkdirSync('examples', { recursive: true });
const jsonl = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
writeFileSync('examples/session.jsonl', jsonl, 'utf8');

const messages = parseTranscript(jsonl);
const result = trimTranscript(messages);
console.log(JSON.stringify(result.stats, null, 2));

function toEntry(m: (typeof messages)[number]) {
  if (m.role === 'user') {
    const content: unknown =
      m.toolResults && m.toolResults.length > 0
        ? m.toolResults.map((r) => toolResult(r.tool_use_id, r.text, r.isError))
        : m.text;
    return { type: 'user', message: { role: 'user', content } };
  }
  const blocks: unknown[] = [];
  if (m.text) blocks.push({ type: 'text', text: m.text });
  for (const u of m.toolUses) blocks.push(toolUse(u.tool_use_id, u.tool, u.input));
  const content = blocks.length === 0 ? m.text : blocks.length === 1 && m.toolUses.length === 0 ? m.text : blocks;
  return { type: 'assistant', message: { role: 'assistant', content } };
}
const trimmedJsonl = result.messages.map((m) => JSON.stringify(toEntry(m))).join('\n') + '\n';
writeFileSync('examples/session.trimmed.jsonl', trimmedJsonl, 'utf8');
console.log('wrote examples/session.jsonl and examples/session.trimmed.jsonl');
