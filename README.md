# show-read-image

A Claude Code mod that draws images inline in the transcript, under the tool call that made them.

- **Reads.** The PNGs the Read tool opens. Several read in one group are drawn side by side, each framed with its name.
- **Other tools.** Images any other tool produced: inline image blocks, as MCP servers return them, and image files
  a command printed and wrote during the call. Listing and search commands (`ls`, `find`, `rg`, `git status`, …) are
  ignored, and a call draws at most four images. A command that writes an image without printing its path draws
  nothing; Read it, or show it with `show_images`.
- **`show_images` tool.** A deferred tool that shows image files without the agent loading them, with a title, labels
  and `version: -1` for the previous version of a path.
- **Marked when unread.** Any card drawn from a file the agent never loaded says "not read by the agent", so it is
  never taken as what the agent saw.
- **Before/after pairs.** `x.before.png` and `x.after.png` read together are drawn as a pair, with a toggle for both,
  after only or before only.
- **Versions.** Each new content of a path is kept as a version (the last 10), under `~/.cache/show-read-image/`.
  A picture with history has two views: Now, with ◀ ▶ to step back, and Side by side, with the newest six.
- **Aspect warning.** Shots whose aspect ratios differ by more than 10% get a warning, since they are not comparable.
- **Videos.** A `.mov`, `.mp4` or `.m4v` shown with `show_images`, or printed by a command, draws as a grid of eight
  timed frames, captioned with its length, frame count and longest gap between frames. A screen recording only stores
  a frame when something changed, so a long gap during an animation is a hitch. `open` plays it in the system
  player. The grid comes from AVFoundation on macOS (a Swift helper compiled on first use) or from ffmpeg and ffprobe
  elsewhere. There, frames aren't stamped with their time, so the eight sample times go in a dim row under the
  grid; clips over a minute are sampled by seeking to each frame rather than decoding the whole video.
- **Expand.** ⤢ on any picture opens it in a pane beside the chat, as large as the pane allows, with ◀ ▶ through
  its versions when it has any.
- **One way to compare.** A card with several images has `[ side by side ] [ A only ] [ B only ]` for two, and
  `[ all ] [ vs B ] [ vs C ] …` for more, each beside the first.
- **Size.** Pictures are sized from the terminal's measured cells. Small ones draw up to twice their pixels (2× under
  400 px, tapering to 1× at 800), larger ones at their own size, never narrower than 16 columns, and within 60% of
  the visible rows.
- **No duplicates.** A command's card is not drawn once a later Read shows the same picture.

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
