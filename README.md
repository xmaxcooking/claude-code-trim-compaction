# claude-code-trim-compaction

A Claude Code plugin, `trim-compaction`, that compacts a long session by
trimming instead of summarising. Old tool outputs are cut to their first lines
and old edit contents become one-line stubs. Every message you and Claude
wrote stays word for word. No model is involved, so it runs in milliseconds
and uses no tokens.

The repo started as an attempt to let local
[Laya](https://huggingface.co/convaiinnovations/laya) models decide what to
cut. The study that followed found that trimming by rule does what a
fine-tuned Laya would do, so the plugin uses the rule. See
[What happened to Laya](#what-happened-to-laya).

## What it does

When a turn ends with the context at 60% or more, or when you run `/compact`:

1. **Trim.** Outside the newest 6 messages:
   - Every tool output of 1,000+ characters is cut to its first 300
     characters plus a note (`[trim-compaction truncated N chars of this
     tool result; re-run the tool if needed]`).
   - Every `Edit`/`Write`/`MultiEdit`/`NotebookEdit` input of 1,000+
     characters keeps its file path, and its long text fields become
     `[compacted: N chars; the change is in the file, read it for the current
     content]`.

   Subagent reports, the todo list, plans and skills are never trimmed.
2. **Decide.** If the trimmed history fits under 40% of the context window, it
   replaces the history word for word, with no summary. If it doesn't, Claude
   Code's own summary runs on the trimmed history, which is smaller, so the
   summary is faster and cheaper than usual.

Measured on four long real sessions (376 to 974 tool calls), with the default
options:

| Session | Smaller by | Time |
| --- | ---: | ---: |
| 974 tool calls | 55% | 11 ms |
| 751 tool calls | 61% | 5 ms |
| 582 tool calls, a lot of conversation text | 37% | 3 ms |
| 376 tool calls | 56% | 2 ms |

For comparison, the built-in `/compact` on a ~911k-token session took 190 s
and read the whole context. Automatic compactions in the same set of sessions
took 32 to 238 s. The built-in summary shrinks the context much more (about
98%), but loses the exact text.

In a live test, `/compact` on a forked 927-message session took 30 ms and left
the context at about 24% of the window. Claude continued normally. It knew
which file it had edited last, noticed that the edit text was compacted, and
said it would read the file again before changing it.

Trimmed content is gone from the context, so Claude has to read a file or run
a command again when it needs the exact text. With hindsight labels on 3,300
old tool calls from real sessions, that was needed for about 0.6% of them.

## Install

Requires Claude Code 2.1.274 or newer.

### Let Claude do it

Paste this into Claude Code:

```text
Install the trim-compaction Claude Code plugin from https://github.com/xmaxcooking/claude-code-trim-compaction:

1. Check that `claude --version` is 2.1.274 or newer. If it is older, stop and tell me.
2. Turn on function hooks. In my user settings file (~/.claude/settings.json, or
   $CLAUDE_CONFIG_DIR/settings.json if that variable is set), set
   env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS to "1". Copy the file to a backup first,
   keep every other setting as it is, and create the file if it doesn't exist.
3. Run `claude plugin marketplace add xmaxcooking/claude-code-trim-compaction`, then
   `claude plugin install trim-compaction@claude-code-trim-compaction`.
4. Run `claude plugin list` and confirm trim-compaction is listed and enabled.
5. Tell me what you changed, where the settings backup is, and that I need to
   restart Claude Code for the plugin to load.
```

### By hand

1. Turn on function hooks. They are early access, and a plugin can't turn
   them on for itself. Add this to `~/.claude/settings.json`:

   ```json
   {
     "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }
   }
   ```

2. Add the marketplace and install the plugin:

   ```sh
   claude plugin marketplace add xmaxcooking/claude-code-trim-compaction
   claude plugin install trim-compaction@claude-code-trim-compaction
   ```

3. Restart Claude Code.

To update: `claude plugin marketplace update claude-code-trim-compaction`,
then `claude plugin update trim-compaction@claude-code-trim-compaction`. To
remove: `claude plugin uninstall trim-compaction@claude-code-trim-compaction`.

To see what it would do to one of your sessions without changing anything,
from a clone of this repo:

```sh
npm install
npm run dry-run -- ~/.claude/projects/<project>/<session>.jsonl
```

## Configuration

`/plugin configure trim-compaction@claude-code-trim-compaction` in Claude Code:

| Option | Default | What it does |
| --- | --- | --- |
| `compactAtPercent` | `60` | Context percentage at which a finished turn compacts. |
| `targetPercent` | `40` | Keep the trimmed history word for word if it fits under this share of the window. Otherwise summarise it. |
| `preserveRecentMessages` | `6` | Newest messages never touched. |
| `minResultChars` | `1000` | Shorter tool outputs are left alone. |
| `truncateHeadChars` | `300` | Characters of a trimmed output that stay. |
| `stubEdits` | `true` | Stub old edit contents. |
| `minInputChars` | `1000` | Shorter edits are left alone. |
| `protectedTools` | `Task, Agent, TodoWrite, ExitPlanMode, Skill` | Tools whose output is never trimmed. |
| `dryRun` | `false` | Log what would happen, but use the built-in summary on the untouched history. |

Each compaction shows a notice like
`trim-compaction: history kept word for word, 56% smaller: 65 tool outputs trimmed, 76 edits stubbed, 1 recent calls untouched; 5ms, about 24% of the window`.
It is also written to the debug log (`claude --debug-file <path>`).

## What happened to Laya

1. **Zero-shot Laya can't judge "still needed".** It scored close to chance
   when asked directly, and worse with more context.
2. **Fine-tuning.** 3,547 old tool calls from 335 local sessions were redacted
   and labelled with hindsight by Claude Haiku. Sonnet gave a second opinion on
   everything Haiku was not confident about, and hand checks were done along
   the way.
3. **What the labels showed.** About 99.4% of old tool outputs and edit
   contents were never needed in full again. Only 19 of about 3,300 were.
4. **The trained model** makes the same decisions as "trim everything", with
   93% and 100% agreement with the labels, exactly like the rule. The rare
   items worth keeping are too few to learn or measure.

The numbers are in [docs/laya-study.md](docs/laya-study.md). The study code
was removed once it had answered the question.

## Development

```sh
npm install
npm test              # all TypeScript tests
npm run typecheck     # library, and the hook against Claude Code's types
npm run dry-run -- <session.jsonl>

CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .   # run the plugin from the working tree
```

An installed plugin is a copy. Bump the version in `.claude-plugin/plugin.json`
before `claude plugin update`, or use `--plugin-dir .` while developing.
`types/claude-code.d.ts` came from Claude Code 2.1.274. Function hooks may
change between releases, so regenerate it with `/plugin-types` after an
upgrade and run `npm run typecheck`.

```
.claude-plugin/       plugin and marketplace manifests
hooks/                the hook: trim, then verbatim or summary of the trimmed history
src/trim.ts           the trimming rules
src/messages.ts       transcript types and tool-call pairing
src/transcript.ts     reads Claude Code .jsonl transcripts
scripts/              dry run, transcript anonymizer (development only)
tests/                tests, with an anonymized real session as a fixture
docs/laya-study.md    why the plugin uses no model
```

## Credits

- [Laya](https://github.com/NandhaKishorM/laya) by Convai Innovations
  (Apache-2.0): the models used in the study.

MIT license, see [LICENSE](LICENSE).
