import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseTranscript } from '../src/transcript.js';

describe('parseTranscript', () => {
  const messages = parseTranscript(readFileSync(new URL('./fixtures/session.jsonl', import.meta.url), 'utf8'));

  it('keeps the main conversation and skips sidechains, meta entries and junk', () => {
    expect(messages.map((m) => m.role)).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user',
      'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant',
    ]);
    expect(messages.flatMap((m) => m.toolUses).map((t) => t.tool_use_id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('reads text, tool inputs and results, and copies the outcome onto the tool use', () => {
    expect(messages[1]).toMatchObject({
      text: 'Looking at the parser.',
      toolUses: [{ tool: 'Read', input: { file_path: 'src/parser.ts' } }],
    });
    const failing = messages[4]!.toolResults![0]!;
    expect(failing.isError).toBe(true);
    expect(failing.text.startsWith('FAIL FAIL')).toBe(true);
    expect(messages[3]!.toolUses[0]).toMatchObject({ isError: true, text: failing.text });
  });
});
