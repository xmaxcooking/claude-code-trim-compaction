import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { choose, resolveHookConfig, summarize } from '../hooks/trim-compaction.ts';
import { callSites, type Message } from '../src/messages.js';
import { stubInput, trimTranscript } from '../src/trim.js';
import { parseTranscript } from '../src/transcript.js';

type SessionMessage = Message & { handle?: string };

const big = (label: string) => `${label} `.repeat(400);

function transcript(): SessionMessage[] {
  const call = (id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage[] => [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input, text }], handle: `h-${id}` },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError: false }], handle: `r-${id}` },
  ];
  return [
    { role: 'user', text: 'Fix the parser test.', toolUses: [], handle: 'h-0' },
    ...call('a', 'Read', { file_path: 'src/parser.ts' }, big('parser')),
    ...call('b', 'Write', { file_path: 'src/new.ts', content: big('content') }, 'File created.'),
    ...call('c', 'Agent', { prompt: 'look around' }, big('report')),
    ...call('d', 'Bash', { command: 'ls' }, 'a.ts b.ts'),
    ...call('e', 'Read', { file_path: 'src/lexer.ts' }, big('lexer')),
    { role: 'assistant', text: 'Fixing now.', toolUses: [], handle: 'h-11' },
    { role: 'user', text: 'go ahead', toolUses: [], handle: 'h-12' },
  ];
}

describe('trimTranscript', () => {
  it('trims old outputs, stubs old edits, and leaves protected, small and recent calls alone', () => {
    const input = transcript();
    const { messages, stats, decisions } = trimTranscript(input, { preserveRecentMessages: 4 });

    expect(decisions.map((d) => [d.tool, d.trimmed, d.stubbed, d.pinned])).toEqual([
      ['Read', true, false, false],
      ['Write', false, true, false],
      ['Agent', false, false, false],
      ['Bash', false, false, false],
      ['Read', false, false, true],
    ]);
    const read = messages[2]!.toolResults![0]!.text;
    expect(read.startsWith('parser parser')).toBe(true);
    expect(read).toMatch(/truncated \d+ chars/);
    expect(messages[3]!.toolUses[0]!.input).toEqual({
      file_path: 'src/new.ts',
      content: expect.stringMatching(/^\[compacted: \d+ chars; the change is in the file/),
    });
    expect(messages[6]!.toolResults![0]!.text).toBe(big('report'));
    expect(messages.map((m) => m.text)).toEqual(input.map((m) => m.text));
    expect(stats).toMatchObject({ outputsTrimmed: 1, editsStubbed: 1, pinned: 1 });
    // The protected Agent report and the recent read stay whole.
    expect(stats.charsAfter).toBeLessThan(stats.charsBefore * 0.6);
  });

  it('returns untouched messages as the same objects', () => {
    const input = transcript();
    const { messages } = trimTranscript(input, { preserveRecentMessages: 4 });
    expect(messages[0]).toBe(input[0]);
    expect(messages[7]).toBe(input[7]);
    expect(messages[1]).not.toBe(input[1]);
  });

  it('can leave edits alone', () => {
    expect(trimTranscript(transcript(), { preserveRecentMessages: 4, stubEdits: false }).stats.editsStubbed).toBe(0);
  });

  it('stubs only long strings and keeps the input shape', () => {
    expect(
      stubInput({ file_path: 'a.ts', replace_all: false, old_string: 'x', new_string: 'y'.repeat(500), edits: [{ old_string: 'z'.repeat(300) }] }),
    ).toEqual({
      file_path: 'a.ts',
      replace_all: false,
      old_string: 'x',
      new_string: expect.stringMatching(/^\[compacted: 500 chars/),
      edits: [{ old_string: expect.stringMatching(/^\[compacted: 300 chars/) }],
    });
  });
});

describe('choose', () => {
  const result = (before: number, after: number) => ({ stats: { charsBefore: before, charsAfter: after } as never });

  it('keeps the trimmed history verbatim when it fits under the target', () => {
    expect(choose(result(100, 40), { tokens: 600_000, window: 1_000_000 }, 40)).toEqual({
      outcome: 'verbatim',
      estimatedPercent: 24,
    });
  });

  it('summarises the trimmed history when it is still too large', () => {
    expect(choose(result(100, 80), { tokens: 900_000, window: 1_000_000 }, 40)).toMatchObject({
      outcome: 'summary-of-trimmed',
    });
  });

  it('falls back to the reduction ratio without token figures, and reports nothing to do', () => {
    expect(choose(result(100, 40), {}, 40).outcome).toBe('verbatim');
    expect(choose(result(100, 70), {}, 40).outcome).toBe('summary-of-trimmed');
    expect(choose(result(100, 100), {}, 40).outcome).toBe('unchanged');
  });
});

describe('hook config', () => {
  it('fills in defaults and reads userConfig values', () => {
    expect(resolveHookConfig({})).toEqual({ compactAtPercent: 60, targetPercent: 40, dryRun: false });
    expect(
      resolveHookConfig({ targetPercent: 30, preserveRecentMessages: 20, stubEdits: false, protectedTools: 'Agent, Bash', dryRun: 'yes' }),
    ).toMatchObject({ targetPercent: 30, preserveRecentMessages: 20, stubEdits: false, protectedTools: ['Agent', 'Bash'], dryRun: true });
  });

  it('keeps engine handles on untouched messages and drops them on rebuilt ones', () => {
    const input = transcript();
    const result = trimTranscript(input, { preserveRecentMessages: 4 });
    const handles = result.messages.map((m) => (m as SessionMessage).handle ?? '(rebuilt)');
    expect(handles).toEqual([
      'h-0', '(rebuilt)', '(rebuilt)', '(rebuilt)', 'r-b', 'h-c', 'r-c', 'h-d', 'r-d', 'h-e', 'r-e', 'h-11', 'h-12',
    ]);
    expect(summarize(result)).toMatch(/^\d+% smaller: 1 tool outputs trimmed, 1 edits stubbed, 1 recent calls untouched/);
  });
});

describe('real session (anonymized)', () => {
  const session = () =>
    parseTranscript(gunzipSync(readFileSync(new URL('./fixtures/real-session.jsonl.gz', import.meta.url))).toString('utf8'));

  // 36% of this session is conversation text, which always stays.
  it('trims over a third of a real 1369-message session and keeps it consistent', () => {
    const input = session();
    const { messages, stats } = trimTranscript(input);
    expect(stats.charsAfter / stats.charsBefore).toBeLessThan(0.65);
    expect(messages.map((m) => m.text)).toEqual(input.map((m) => m.text));
    expect(messages.slice(-6)).toEqual(input.slice(-6));
    const uses = new Set(messages.flatMap((m) => m.toolUses.map((u) => u.tool_use_id)));
    for (const m of messages) for (const r of m.toolResults ?? []) expect(uses.has(r.tool_use_id)).toBe(true);
    expect(callSites(messages)).toHaveLength(callSites(input).length);
  });
});
