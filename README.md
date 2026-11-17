# show-read-image

A Claude Code mod that draws images inline in the transcript, under the tool call that made them.

- **Reads.** The PNGs the Read tool opens. Several read in one group are drawn side by side, each framed with its name.
- **Other tools.** Images any other tool produced:
  - inline image blocks, as MCP servers return them;
  - image paths a command printed;
  - for commands that make an image without printing its path (`screencapture`, `simctl io … screenshot`, `sips`,
    `magick`, `ffmpeg`, …), the paths named in the command.

  Listing and search commands (`ls`, `find`, `rg`, `git status`, …) are ignored, and a call draws at most four images.
- **`show_images` tool.** A deferred tool that shows image files without the agent loading them, with a title, labels
  and `version: -1` for the previous version of a path.
- **Marked when unread.** Any card drawn from a file the agent never loaded says "not read by the agent", so it is
  never taken as what the agent saw.
- **Before/after pairs.** `x.before.png` and `x.after.png` read together are drawn as a pair, with a toggle for both,
  after only or before only.
- **Versions.** Each new content of a path is kept as a version (the last 10), under `~/.cache/show-read-image/`.
  A picture with history has two views: Now, with ◀ ▶ to step back, and Side by side, with the newest six.
- **Aspect warning.** Shots whose aspect ratios differ by more than 10% get a warning, since they are not comparable.
- **One way to compare.** A card with several images has `[ side by side ] [ A only ] [ B only ]` for two, and
  `[ all ] [ vs B ] [ vs C ] …` for more, each beside the first.
- **True size.** Pictures are sized from the terminal's measured cell shape (2:1 where it reports no pixel size),
  never drawn larger than their own pixels (with a 16-column floor so tiny ones stay visible), and kept within 60%
  of the visible rows.

JPEGs, and PNGs over the 2 MiB an image may take, are converted and scaled down with whichever of `sips`, `magick`,
`convert` or `ffmpeg` the machine has. Without one of them, those images get no card.

Verified in Ghostty inside tmux, without `CLAUDE_CODE_FORCE_TERMINAL_IMAGES`. A session hosted by `claude bg-pty-host`
sees `TERM=xterm-256color` with no tmux or terminal variables, so it draws the `[image: ...]` alt text instead. Resume
the session in the tmux pane itself to get pictures.

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
