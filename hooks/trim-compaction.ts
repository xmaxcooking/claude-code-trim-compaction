import type {
  EngineInterface,
  On,
  PluginOptions,
  Register,
  SessionMessage,
  TurnCompleteInput,
} from 'claude-code';

import { reductionRatio, trimTranscript, type TrimOptions, type TrimResult } from '../src/trim.js';

/**
 * Compacts by trimming. Old tool outputs are cut to their first lines and old
 * edit contents become stubs (src/trim.ts). When the trimmed history fits under
 * `targetPercent` of the context window, it replaces the history word for word.
 * When it does not, Claude Code's own summary runs on the trimmed history,
 * which is smaller and so faster and cheaper to summarise than the original.
 */

export type HookConfig = TrimOptions & {
  compactAtPercent: number;
  targetPercent: number;
  dryRun: boolean;
};

const HOOK_DEFAULTS = { compactAtPercent: 60, targetPercent: 40, dryRun: false };

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionBoolean(options: PluginOptions, key: string, fallback: boolean): boolean {
  const value = options[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return /^(1|true|yes|on)$/i.test(value.trim());
  return fallback;
}

/** Reads the plugin's `userConfig` values. Anything missing takes the default. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const config: HookConfig = {
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    targetPercent: optionNumber(options, 'targetPercent', HOOK_DEFAULTS.targetPercent),
    dryRun: optionBoolean(options, 'dryRun', HOOK_DEFAULTS.dryRun),
  };
  for (const key of ['preserveRecentMessages', 'minResultChars', 'truncateHeadChars', 'minInputChars'] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) config[key] = value;
  }
  if (options['stubEdits'] !== undefined) config.stubEdits = optionBoolean(options, 'stubEdits', true);
  const tools = options['protectedTools'];
  if (typeof tools === 'string' && tools.trim()) {
    config.protectedTools = tools.split(',').map((t) => t.trim()).filter(Boolean);
  }
  return config;
}

export type Outcome = 'verbatim' | 'summary-of-trimmed' | 'unchanged';

/**
 * Verbatim when the trimmed history is estimated to fit under targetPercent of
 * the window. Otherwise the built-in summary runs on the trimmed history. With
 * no token count from the host, a reduction of at least half counts as enough.
 */
export function choose(
  result: Pick<TrimResult, 'stats'>,
  context: { tokens?: number; window?: number },
  targetPercent: number,
): { outcome: Outcome; estimatedPercent?: number } {
  const ratio = reductionRatio(result);
  if (ratio <= 0) return { outcome: 'unchanged' };
  if (context.tokens !== undefined && context.window) {
    const estimatedPercent = (context.tokens * (1 - ratio) * 100) / context.window;
    return { outcome: estimatedPercent <= targetPercent ? 'verbatim' : 'summary-of-trimmed', estimatedPercent };
  }
  return { outcome: ratio >= 0.5 ? 'verbatim' : 'summary-of-trimmed' };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: TrimResult): string {
  const { stats } = result;
  return `${percent(reductionRatio(result))} smaller: ${stats.outputsTrimmed} tool outputs trimmed, ${stats.editsStubbed} edits stubbed, ${stats.pinned} recent calls untouched; ${stats.ms}ms`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify($: EngineInterface, text: string): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const result = trimTranscript(event.messages, configured);
      let context: { tokens?: number; window?: number } = {};
      try {
        context = (await $.session.usage()).context;
      } catch {
        // Without usage figures, choose() falls back to the reduction ratio.
      }
      const { outcome, estimatedPercent } = choose(result, context, configured.targetPercent);
      const estimate = estimatedPercent === undefined ? '' : `, about ${Math.round(estimatedPercent)}% of the window`;
      if (configured.dryRun) {
        notify($, `trim-compaction dry run: would give ${outcome} (${summarize(result)}${estimate}); built-in summary used`);
        return next(event);
      }
      if (outcome === 'unchanged') {
        notify($, 'trim-compaction: nothing old enough to trim; built-in summary used');
        return next(event);
      }
      // Unchanged messages are the engine's own objects (handle included), so it
      // keeps them as they are. Changed ones carry no handle, so it takes them as built.
      const messages: SessionMessage[] = result.messages;
      if (outcome === 'verbatim') {
        notify($, `trim-compaction: history kept word for word, ${summarize(result)}${estimate}`);
        return { messages };
      }
      notify($, `trim-compaction: ${summarize(result)}${estimate}; still above ${configured.targetPercent}%, summarising the trimmed history`);
      return next({ ...event, messages });
    } catch (error) {
      notify($, `trim-compaction: built-in summary used (${errorText(error)})`);
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(`trim-compaction: auto-compact skipped (${errorText(error)})`);
    } finally {
      compacting = false;
    }
    return next(event);
  });
};
