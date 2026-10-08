# claude-code-trim-compaction

A Claude Code plugin that keeps long sessions going by trimming old content
instead of summarizing it.

## What it does

Claude Code has a context window: a limit on how much conversation it can
hold. When a long session gets close to that limit, Claude Code normally
"compacts" by asking a model to summarize everything so far. That takes time,
costs tokens, and rewrites details in its own words.

This plugin trims instead. When a turn ends with the context mostly full (60%
by default), or when you run `/compact`, it goes through everything except the
newest 6 messages and shrinks two kinds of content:

- **Old tool outputs** (like a big file read) are cut down to their first 300
  characters, with a note that they were trimmed.
- **Old edit contents** (the before/after text of a code change) are replaced
  with a short note that the file was changed.

Every message you and Claude actually typed stays exactly as written. If the
trimmed history is now small enough (under 40% of the window), it's used as
is, with no summary at all. If it's still too big, Claude Code's normal
summarizer runs on it, but since it's already smaller, that's faster and
cheaper than usual.

This works because, in testing, old tool outputs and edit contents were
almost never needed again in full (about 99.4% of the time, trimming them
loses nothing useful). If Claude does need the exact content later, it just
re-reads the file or re-runs the command.

### Examples

**A tool output.** Claude reads `src/rateLimiter.ts`, a 1,164-character file.
That's over the 1,000-character minimum, so once the call is old enough, the
result is cut to its first 300 characters and a note. The other 864
characters, which is most of the actual logic, are gone from the transcript:

```text
Before (full 1,164-character tool result):
  import { Clock } from "./clock";

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

    availableTokens(): number {
      this.refill();
      return Math.floor(this.tokens);
    }

    reset(): void {
      this.tokens = this.capacity;
      this.lastRefill = this.clock.now();
    }
  }

After (the same 300 characters, then a note):
  import { Clock } from "./clock";

  export class RateLimiter {
    private tokens: number;
    private lastRefill: number;

    constructor(
      private readonly capacity: number,
      private readonly refillPerSecond: number,
      private readonly clock: Clock = new Clock(),
    ) {
      this.tokens = capacity;
  [trim-compaction truncated 864 chars of this tool result; re-run the
  tool if needed]
```

The 864 cut characters aren't boilerplate. They're `tryAcquire`, `refill`,
`availableTokens`, and `reset`, which is most of the file's actual behavior.
The first 300 characters are never "the important part"; they just happen to
be whatever comes first (here, the constructor).

**Why that's fine to cut.** This only happens once the call is no longer one
of the newest 6 messages, meaning the conversation has already moved past it.
By then, Claude has already done something with that file: explained what it
found, pointed out a bug, or made an edit. That explanation stays in the
conversation word for word, untouched. The raw file text sitting in the old
tool result is just a second copy of something that's either already acted
on, or still sitting unchanged on disk, one `Read` away if it's ever actually
needed again. Across 3,300 old tool calls and edits from real sessions,
hand-labelled with hindsight by Claude itself, that turned out to be true for
99.4% of them; only 19 were ever needed in full again.

**An edit.** Claude changes a function. The call that made the change is
long, so once it's old enough its text is replaced with a stub, but the file
path stays:

```text
Before:
  Edit(file_path: "src/server.ts",
       old_string: "function parseConfig(raw: string) {\n  ... 40 lines ...\n}",
       new_string: "function parseConfig(raw: string): Config {\n  ... 55 lines, now with validation ...\n}")

After:
  Edit(file_path: "src/server.ts",
       old_string: "[compacted: 612 chars; the change is in the file, read it
                     for the current content]",
       new_string: "[compacted: 840 chars; the change is in the file, read
                     it for the current content]")
```

Your instruction ("add validation to parseConfig") and Claude's explanation
of what it changed stay word for word in the conversation. Only the literal
before/after code text of the edit itself is replaced. The current code is
in the file, not the chat history, so that's where Claude looks if it needs
it again.

### How

Each tool call and edit in the transcript is a separate JSON record, so the
hook can rewrite the long text fields of old records in place without
touching anything else: the surrounding messages, their order, and anything
inside the newest 6 messages are left exactly as they were. No model reads or
rewrites the conversation. It's plain string truncation, which is why it
runs in milliseconds.

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
