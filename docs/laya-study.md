# Why the plugin uses no model

This repo began with the idea that open
[Laya](https://huggingface.co/convaiinnovations/laya) models, running locally,
would decide which old tool calls a compaction may cut. The study
below (2026-09-23/24, 335 local sessions, RTX 5060) found that a plain rule
makes the same decisions, so the plugin uses the rule. The study code was
removed from the repo afterwards.

## 1. Zero-shot Laya

- Asked "is this tool output still needed?", all three checkpoints (english,
  multilingual, typed-decisions) scored close to chance, whatever the wording.
  A config file the task was editing scored the same as an `ls` from 40 calls
  earlier.
- Laya reads at most 512 or 1,024 tokens per question and cuts the rest.
  Raising the limit to 8,192 (the encoder allows it) and adding the later
  history made it worse than chance (ROC AUC 0.43) and 16 times slower.
- Stating computed facts ("the file was edited 3 times since", "last mentioned
  12 messages ago") helped (AUC 0.72). The one-line rule "the file or pattern
  was mentioned recently" did better (0.82).
- On four real sessions, Laya's topical question removed nothing.

## 2. Fine-tuning

- **Data:** 3,547 old tool outputs and edit inputs at 133 simulated compaction
  points. Credentials, personal data, names (git metadata plus two local NER
  models), addresses, company, project and ticket names were redacted before
  anything was stored or sent. Duplicate and forked sessions were excluded.
  The split was by session, with one whole project held out.
- **Labels:** Claude Haiku labelled every item with hindsight (it saw the next
  150 messages). A hand check showed its "keep" labels were mostly wrong. Claude
  Sonnet relabelled the 736 items Haiku was unsure about. Sonnet's keeps were
  asked again with the reason first, and 19 of 75 held up. Those were genuine,
  typically a file read earlier and later edited by quoting its old text
  without re-reading it. Labelling used about 1.1M Haiku and 1M Sonnet tokens.
- **The labels' verdict:** About 99.4% of old items could have been dropped,
  cut to their first lines, or stubbed. 19 of about 3,300 had to stay in full.
- **Training** (typed-decisions checkpoint, soft cross-entropy):

  | | zero-shot | decision layers | + top 4 encoder layers | trim everything |
  | --- | ---: | ---: | ---: | ---: |
  | agreement with labels, outputs | 3% | 93% | 93% | 93% |
  | agreement with labels, edits | 0% | 100% | 100% | 100% |
  | genuine keeps caught (2 held out) | 2* | 0 | 0 | 0 |

  \* by keeping almost everything.

The trained model learned "trim everything old". The one decision where a
model could beat the rule, spotting the rare item worth keeping, had 19
examples in total, too few to learn or even measure. At that rate a few
hundred examples would need about 50,000 labelled items, and the sessions gave
3,500.

## 3. The rule

Cutting every old tool output to 300 characters and stubbing every old edit
removes 37-61% of the context on four long sessions, in 2-11 ms, with no
tokens. By the labels it cuts something still needed about 0.6% of the time,
which costs a re-read. The built-in `/compact` removes about 98%, but took
190 s and read ~911k tokens on the same kind of session.
