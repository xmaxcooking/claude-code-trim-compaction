import type { Message, ToolResult, ToolUse } from './messages.js';

/**
 * Reads a Claude Code session transcript (the `.jsonl` files under
 * `~/.claude/projects/<project>/`) into messages, for the dry-run script and
 * the tests. It keeps only the main conversation and skips sidechain (subagent)
 * entries, meta entries, anything that is not a user or assistant message, and
 * lines that do not parse.
 */

type Block = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

type Entry = {
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { role?: string; content?: unknown };
};

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: Block) => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

export function parseTranscript(jsonl: string): Message[] {
  return parseSegments(jsonl).flat();
}

/**
 * The transcript split at Claude Code's own compactions (`compact_boundary`
 * entries). Each segment holds what was in context between two of them,
 * including the summary that opens a later segment.
 */
function parseSegments(jsonl: string): Message[][] {
  const segments: Message[][] = [[]];
  let messages = segments[0]!;
  const uses = new Map<string, ToolUse>();
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.isSidechain || entry.isMeta) continue;
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      if (messages.length > 0) {
        messages = [];
        segments.push(messages);
      }
      continue;
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const role = entry.type;
    const content = entry.message?.content;
    const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];

    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
    const toolUses: ToolUse[] = [];
    const toolResults: ToolResult[] = [];
    for (const block of blocks) {
      if (role === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
        const input =
          block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
        const use: ToolUse = { tool_use_id: block.id, tool: block.name ?? 'unknown', input };
        uses.set(block.id, use);
        toolUses.push(use);
      }
      if (role === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const result: ToolResult = {
          tool_use_id: block.tool_use_id,
          text: blockText(block.content),
          isError: block.is_error === true,
        };
        toolResults.push(result);
        // Claude Code's SessionMessage carries the outcome on the tool use too.
        const use = uses.get(block.tool_use_id);
        if (use) {
          use.text = result.text;
          if (result.isError) use.isError = true;
        }
      }
    }
    if (!text.trim() && toolUses.length === 0 && toolResults.length === 0) continue;
    const message: Message = { role, text, toolUses };
    if (toolResults.length > 0) message.toolResults = toolResults;
    messages.push(message);
  }
  return segments.filter((segment) => segment.length > 0);
}
