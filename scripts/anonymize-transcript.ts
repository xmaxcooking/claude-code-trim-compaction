/**
 * Turns a real Claude Code transcript into a test fixture with none of its
 * content. Every text, tool output and free-form tool input becomes filler of
 * the same length. File paths and commands become consistent placeholders
 * (`src/file-3.ts`, `command-7`), MCP tool names are numbered, and every field
 * parseTranscript does not read (cwd, branch, ids, timestamps, ...) is dropped.
 * The fixture keeps the roles, tool names, sizes, and which calls touch the
 * same file or run the same command.
 *
 *   npx tsx scripts/anonymize-transcript.ts <in.jsonl> <out.jsonl.gz>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BUILTIN_TOOLS = new Set([
  'Agent', 'Bash', 'BashOutput', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'KillShell', 'LS',
  'MultiEdit', 'NotebookEdit', 'NotebookRead', 'PowerShell', 'Read', 'Skill', 'Task',
  'TaskOutput', 'TaskStop', 'TodoWrite', 'ToolSearch', 'WebFetch', 'WebSearch', 'Write',
]);
const PATH_KEYS = new Set(['file_path', 'notebook_path', 'path']);
const KEPT_KEYS = new Set(['offset', 'limit', 'replace_all', 'run_in_background', 'timeout', 'head_limit']);
/** Claude Code's interrupt markers carry no user content, so they stay as they are. */
const KEPT_TEXT = /^\[Request interrupted by user[^\]]*\]$/;

const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(' ');
const FILLER = Array.from({ length: 4000 }, (_, i) => WORDS[(i * 7) % WORDS.length]).join(' ');

function filler(length: number): string {
  let out = '';
  while (out.length < length) out += FILLER;
  return out.slice(0, length);
}

function numbered(prefix: string) {
  const seen = new Map<string, string>();
  return (key: string, make: (n: number) => string): string => {
    let value = seen.get(key);
    if (!value) {
      value = make(seen.size + 1);
      seen.set(key, value);
    }
    return value;
  };
}

const paths = numbered('file');
const commands = numbered('command');
const tools = numbered('tool');

function anonPath(value: string): string {
  const normal = value.replace(/\\/g, '/').toLowerCase();
  const ext = /\.([a-z0-9]{1,8})$/.exec(normal)?.[1];
  return paths(normal, (n) => `src/file-${n}${ext ? `.${ext}` : ''}`);
}

function anonValue(key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    if (PATH_KEYS.has(key)) return anonPath(value);
    if (key === 'command') return commands(value.trim().replace(/\s+/g, ' '), (n) => `command-${n}`);
    return filler(value.length);
  }
  if (Array.isArray(value)) return value.map((item) => anonValue(key, item));
  if (value && typeof value === 'object') return anonInput(value as Record<string, unknown>);
  return KEPT_KEYS.has(key) || typeof value === 'boolean' ? value : value;
}

function anonInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, anonValue(key, value)]));
}

function anonText(text: string): string {
  return KEPT_TEXT.test(text.trim()) ? text : filler(text.length);
}

type Block = Record<string, unknown>;

function anonBlock(block: Block): Block | undefined {
  switch (block['type']) {
    case 'text':
      return { type: 'text', text: anonText(String(block['text'] ?? '')) };
    case 'tool_use': {
      const name = String(block['name'] ?? 'unknown');
      return {
        type: 'tool_use',
        id: block['id'],
        name: BUILTIN_TOOLS.has(name) ? name : tools(name, (n) => `mcp__tool_${n}`),
        input: anonInput((block['input'] as Record<string, unknown>) ?? {}),
      };
    }
    case 'tool_result': {
      const content = block['content'];
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((part: Block) => (part['type'] === 'text' ? String(part['text'] ?? '') : '')).join('\n')
            : '';
      const out: Block = { type: 'tool_result', tool_use_id: block['tool_use_id'], content: filler(text.length) };
      if (block['is_error']) out['is_error'] = true;
      return out;
    }
    default:
      return undefined;
  }
}

function main(): void {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: npx tsx scripts/anonymize-transcript.ts <in.jsonl> <out.jsonl.gz>');
    process.exit(2);
  }
  const lines: string[] = [];
  let ids = 0;
  const idMap = new Map<string, string>();
  const anonId = (id: unknown) => {
    const key = String(id);
    if (!idMap.has(key)) idMap.set(key, `toolu_${++ids}`);
    return idMap.get(key)!;
  };
  for (const line of readFileSync(input, 'utf8').split(/\r?\n/)) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry['type'] !== 'user' && entry['type'] !== 'assistant') continue;
    const message = entry['message'] as { role?: string; content?: unknown } | undefined;
    const content = message?.content;
    const blocks =
      typeof content === 'string'
        ? [{ type: 'text', text: anonText(content) }]
        : Array.isArray(content)
          ? content.map(anonBlock).filter((b): b is Block => b !== undefined)
          : [];
    for (const block of blocks) {
      if ('id' in block) block['id'] = anonId(block['id']);
      if ('tool_use_id' in block) block['tool_use_id'] = anonId(block['tool_use_id']);
    }
    const out: Record<string, unknown> = { type: entry['type'], message: { role: message?.role, content: blocks } };
    if (entry['isSidechain']) out['isSidechain'] = true;
    if (entry['isMeta']) out['isMeta'] = true;
    lines.push(JSON.stringify(out));
  }
  writeFileSync(output, gzipSync(lines.join('\n') + '\n', { level: 9 }));
  console.log(`${lines.length} entries -> ${output}`);
}

main();
