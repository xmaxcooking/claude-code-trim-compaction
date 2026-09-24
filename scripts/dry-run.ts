/**
 * Shows what the plugin would do to a real session, without touching it.
 *
 *   npm run dry-run -- <transcript.jsonl> [<more.jsonl> ...] [--json]
 *
 * Transcripts live under ~/.claude/projects/<project>/<session>.jsonl. Each is
 * trimmed as it stands (all of it, as if compacted now), with the plugin's
 * default options.
 */
import { readFileSync } from 'node:fs';

import { reductionRatio, trimTranscript } from '../src/trim.js';
import { parseTranscript } from '../src/transcript.js';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (files.length === 0) {
  console.error('usage: npm run dry-run -- <transcript.jsonl> [...] [--json]');
  process.exit(2);
}

for (const file of files) {
  const messages = parseTranscript(readFileSync(file, 'utf8'));
  const result = trimTranscript(messages);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ file, stats: result.stats }, null, 2));
    continue;
  }
  const { stats } = result;
  console.log(
    `${file.split(/[\\/]/).pop()}: ${stats.calls} tool calls; ` +
      `${stats.charsBefore} -> ${stats.charsAfter} chars (${Math.round(reductionRatio(result) * 100)}% smaller) in ${stats.ms}ms; ` +
      `${stats.outputsTrimmed} outputs trimmed, ${stats.editsStubbed} edits stubbed`,
  );
}
