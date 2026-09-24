import { callSites, jsonLength, sizeOf, type Message, type ToolResult, type ToolUse } from './messages.js';

/**
 * Rules-only compaction. Everything outside the first message and the newest
 * ones is trimmed. Nothing is summarised and no model is asked.
 *
 * - Tool outputs are cut to their first `truncateHeadChars` characters plus a
 *   note. The call itself stays, so the history still shows what was done.
 * - Edit/Write/MultiEdit/NotebookEdit inputs keep their file path, and their
 *   long strings (old and new text, written content) become a note. The change
 *   is already in the file, so the text is redundant.
 *
 * It uses no model because, labelled with hindsight, about 99.4% of old tool
 * outputs and edit contents in real sessions were never needed in full again,
 * and a fine-tuned model learned exactly these decisions (docs/laya-study.md).
 */

export interface TrimOptions {
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Tool outputs shorter than this are left alone. Default 1000. */
  minResultChars?: number;
  /** Characters of a trimmed tool output that stay. Default 300. */
  truncateHeadChars?: number;
  /** Replace old edit contents with stubs. Default true. */
  stubEdits?: boolean;
  /** Edit inputs shorter than this (as JSON) are left alone. Default 1000. */
  minInputChars?: number;
  /** Tools whose output is never trimmed. */
  protectedTools?: readonly string[];
}

export type ResolvedTrimOptions = Required<TrimOptions>;

export const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'] as const;

/** Subagent reports, the todo list and plans are summaries already, so they stay whole. */
export const DEFAULT_PROTECTED_TOOLS = ['Task', 'Agent', 'TodoWrite', 'ExitPlanMode', 'Skill'] as const;

export const DEFAULT_TRIM_OPTIONS: ResolvedTrimOptions = {
  preserveRecentMessages: 6,
  minResultChars: 1000,
  truncateHeadChars: 300,
  stubEdits: true,
  minInputChars: 1000,
  protectedTools: DEFAULT_PROTECTED_TOOLS,
};

/** Strings in an edit input shorter than this stay (file paths, flags, short replacements). */
const STUB_STRING_CHARS = 200;
/** An output only a little longer than the head is not worth a note. */
const TRUNCATE_SLACK = 120;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveTrimOptions(options: TrimOptions = {}): ResolvedTrimOptions {
  const d = DEFAULT_TRIM_OPTIONS;
  return {
    preserveRecentMessages: Math.max(0, Math.floor(finite(options.preserveRecentMessages, d.preserveRecentMessages))),
    minResultChars: Math.max(0, finite(options.minResultChars, d.minResultChars)),
    truncateHeadChars: Math.max(0, Math.floor(finite(options.truncateHeadChars, d.truncateHeadChars))),
    stubEdits: options.stubEdits ?? d.stubEdits,
    minInputChars: Math.max(0, finite(options.minInputChars, d.minInputChars)),
    protectedTools: options.protectedTools ?? d.protectedTools,
  };
}

/** The first `headChars` characters and a note, or the text itself when it is short enough. */
export function truncateOutput(text: string, headChars: number): string {
  if (text.length <= headChars + TRUNCATE_SLACK) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[trim-compaction truncated ${text.length - headChars} chars of this tool result; re-run the tool if needed]`;
}

/** The edit input with every long string replaced by a note. The shape and file path stay. */
export function stubInput(input: Record<string, unknown>): Record<string, unknown> {
  const stub = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.length < STUB_STRING_CHARS
        ? value
        : `[compacted: ${value.length} chars; the change is in the file, read it for the current content]`;
    }
    if (Array.isArray(value)) return value.map(stub);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stub(v)]));
    }
    return value;
  };
  return stub(input) as Record<string, unknown>;
}

export interface TrimDecision {
  tool: string;
  /** In the first message or the newest ones, so left alone. */
  pinned: boolean;
  /** The output was cut to its head. */
  trimmed: boolean;
  /** The edit input was replaced by a stub. */
  stubbed: boolean;
}

export interface TrimResult {
  /**
   * The trimmed transcript. Messages, tool uses and results that did not
   * change are the objects that came in, so a host keeps its own. Anything
   * changed is a new object.
   */
  messages: Message[];
  decisions: TrimDecision[];
  stats: {
    charsBefore: number;
    charsAfter: number;
    calls: number;
    outputsTrimmed: number;
    editsStubbed: number;
    pinned: number;
    ms: number;
  };
}

/** Share of characters removed, 0 to 1. */
export function reductionRatio(result: Pick<TrimResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

export function trimTranscript(messages: readonly Message[], options: TrimOptions = {}): TrimResult {
  const started = Date.now();
  const o = resolveTrimOptions(options);
  const recentFrom = messages.length - o.preserveRecentMessages;
  const inWindow = (index: number) => index === 0 || index >= recentFrom;
  const editTools = new Set<string>(EDIT_TOOLS);

  const trim = new Set<string>();
  const stub = new Set<string>();
  const decisions: TrimDecision[] = callSites(messages).map((site) => {
    const { use } = site;
    const pinned = inWindow(site.at) || inWindow(site.answeredAt);
    const trimmed =
      !pinned &&
      !o.protectedTools.includes(use.tool) &&
      site.outputChars >= o.minResultChars &&
      site.outputChars > o.truncateHeadChars + TRUNCATE_SLACK;
    const stubbed = !pinned && o.stubEdits && editTools.has(use.tool) && jsonLength(use.input) >= o.minInputChars;
    if (trimmed) trim.add(use.tool_use_id);
    if (stubbed) stub.add(use.tool_use_id);
    return { tool: use.tool, pinned, trimmed, stubbed };
  });

  const rewriteUse = (use: ToolUse): ToolUse => {
    if (!trim.has(use.tool_use_id) && !stub.has(use.tool_use_id)) return use;
    const next: ToolUse = {
      tool_use_id: use.tool_use_id,
      tool: use.tool,
      input: stub.has(use.tool_use_id) ? stubInput(use.input) : use.input,
    };
    if (use.text !== undefined) next.text = trim.has(use.tool_use_id) ? truncateOutput(use.text, o.truncateHeadChars) : use.text;
    if (use.isError) next.isError = true;
    return next;
  };
  const rewriteResult = (result: ToolResult): ToolResult =>
    trim.has(result.tool_use_id)
      ? { tool_use_id: result.tool_use_id, text: truncateOutput(result.text, o.truncateHeadChars), isError: result.isError }
      : result;

  const out = messages.map((message): Message => {
    const toolUses = message.toolUses.map(rewriteUse);
    const toolResults = message.toolResults?.map(rewriteResult);
    const changed =
      toolUses.some((use, i) => use !== message.toolUses[i]) ||
      (toolResults ?? []).some((result, i) => result !== message.toolResults![i]);
    if (!changed) return message;
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults && toolResults.length > 0) rebuilt.toolResults = toolResults;
    return rebuilt;
  });

  return {
    messages: out,
    decisions,
    stats: {
      charsBefore: messages.reduce((sum, m) => sum + sizeOf(m), 0),
      charsAfter: out.reduce((sum, m) => sum + sizeOf(m), 0),
      calls: decisions.length,
      outputsTrimmed: decisions.filter((d) => d.trimmed).length,
      editsStubbed: decisions.filter((d) => d.stubbed).length,
      pinned: decisions.filter((d) => d.pinned).length,
      ms: Date.now() - started,
    },
  };
}
