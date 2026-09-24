/**
 * The transcript as the plugin sees it. The shapes match Claude Code's
 * `SessionMessage`, `ToolUseSummary` and `ToolResultSummary`, so a session's
 * messages go in as they are and the trimmed ones go straight back.
 */

export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** The call's output, which Claude Code also attaches to the use. */
  text?: string;
  isError?: true;
}

export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError: boolean;
}

export interface Message {
  role: 'user' | 'assistant';
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** Where a tool call and its result sit in the transcript. */
export interface CallSite {
  use: ToolUse;
  /** Message holding the tool_use block. */
  at: number;
  /** Message holding the tool_result block. */
  answeredAt: number;
  outputChars: number;
}

/** Every tool call that has its result in the transcript. Unanswered calls are skipped. */
export function callSites(messages: readonly Message[]): CallSite[] {
  const answers = new Map<string, { at: number; chars: number }>();
  for (const [at, message] of messages.entries()) {
    for (const result of message.toolResults ?? []) answers.set(result.tool_use_id, { at, chars: result.text.length });
  }
  const sites: CallSite[] = [];
  for (const [at, message] of messages.entries()) {
    for (const use of message.toolUses) {
      const answer = answers.get(use.tool_use_id);
      if (answer) sites.push({ use, at, answeredAt: answer.at, outputChars: answer.chars });
    }
  }
  return sites;
}

export function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** How much a message puts into the context, in characters: its text, tool inputs and tool outputs. */
export function sizeOf(message: Message): number {
  return (
    message.text.length +
    message.toolUses.reduce((sum, use) => sum + jsonLength(use.input), 0) +
    (message.toolResults ?? []).reduce((sum, result) => sum + result.text.length, 0)
  );
}
