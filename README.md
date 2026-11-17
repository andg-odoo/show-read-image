# show-read-image

A Claude Code mod that draws the PNGs the Read tool opens inline in the transcript, under the Read row.

- Several images read in one group are drawn side by side, each framed with its name.
- `x.before.png` and `x.after.png` read together are drawn as a pair, with a toggle for both, after only or before only.
- Each re-read of a path whose content changed is kept as a new version (the last 10), so you can step back through
  earlier shots of the same file. Versions are stored under `~/.cache/show-read-image/`.
- Shots whose aspect ratios differ by more than 10% get a warning, since they are not comparable.

Verified in Ghostty inside tmux, without `CLAUDE_CODE_FORCE_TERMINAL_IMAGES`. A session hosted by a background
pty host sees no terminal image support and draws the `[image: ...]` alt text instead.

## Install

Clone it anywhere and add the folder to `CLAUDE_CODE_PLUGIN_DIRS` (colon-separated) in the `env` block of
`~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/show-read-image" } }
```

## Develop

```sh
claude plugin validate .
claude plugin test .
tsc -p .
```

`tsc` needs the Claude Code SDK typings in `.claude-plugin/types/`, which Claude Code writes when it scaffolds a mod
and which are not committed. The tests run without them.
