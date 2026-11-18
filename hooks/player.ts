import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'

import { parseFrameLine } from './logic'

// Plays a video into one keyed Image in the Expand pane: frames come from a helper and are blitted as they arrive,
// keeping only the newest, so a slow terminal drops frames instead of falling behind
export const PLAYER_FPS = 20

// The player's Image is keyed by its size, so a resized pane mounts a new one instead of swapping frames into the
// old size; frames go to whichever key the pane drew last
let imageKey = 'pane-video'

export function playerKey(columns: number, rows: number) {
  imageKey = `pane-video-${columns}x${rows}`
  return imageKey
}

type Child = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

export type Playback = {
  video: string
  // The render site the frames go to: the Expand pane, or the card the video plays in
  site: string
  status: 'starting' | 'playing' | 'paused' | 'ended' | 'failed'
  error: string
  position: number
  first: string | undefined
  // The newest frame shown, kept through a restart so the pane doesn't fall back to the filmstrip
  last: string | undefined
  pending: string | undefined
  isBlitting: boolean
  received: number
  shown: number
  dropped: number
  shownLastSecond: number
  box: { width: number; height: number } | undefined
}

type Run = { child: Child | undefined; poll: { cancel: () => void } | undefined; generation: number; dir?: string }

let playback: Playback | undefined
let run: Run = { child: undefined, poll: undefined, generation: 0 }
let ticker: { cancel: () => void } | undefined
let windowShown = 0

export function current() {
  return playback
}

function redraw($: EngineInterface) {
  $.ui.invalidate('ui.render')
}

async function pump($: EngineInterface, p: Playback, paneId: string) {
  if (p.isBlitting || p.pending === undefined || playback !== p) {
    return
  }
  p.isBlitting = true
  const png = p.pending
  p.pending = undefined
  const result = await $.ui.blit({ requestId: paneId, key: imageKey, source: { png } }).catch((error: unknown) => ({ deny: String(error) }))
  if ('deny' in result && result.deny) {
    p.dropped += 1
  } else {
    p.shown += 1
    windowShown += 1
  }
  p.isBlitting = false
  void pump($, p, paneId)
}

function onFrame($: EngineInterface, p: Playback, paneId: string, png: string, t: number) {
  p.received += 1
  p.position = t
  p.last = png
  // The first frame is drawn by the pane itself, which fixes the Image's size; the rest are blitted into it
  if (!p.first) {
    p.first = png
    p.status = 'playing'
    redraw($)
    return
  }
  if (p.pending !== undefined) {
    p.dropped += 1
  }
  p.pending = png
  void pump($, p, paneId)
}

// Stops the decoder and removes its frames folder, however playback ended
function stopChild($: EngineInterface) {
  run.poll?.cancel()
  const { child, dir } = run
  run = { child: undefined, poll: undefined, generation: run.generation + 1 }
  if (child) {
    void child.return?.(undefined as never)
  }
  if (dir) {
    void $.process.run(['rm', '-rf', dir]).catch(() => undefined)
  }
}

export function stop($: EngineInterface) {
  stopChild($)
  ticker?.cancel()
  ticker = undefined
  playback = undefined
  redraw($)
}

export function pause($: EngineInterface) {
  if (playback && playback.status !== 'ended') {
    stopChild($)
    playback.status = 'paused'
    redraw($)
  }
}

export type Source = { kind: 'helper'; argv: string[] } | { kind: 'files'; argv: string[]; dir: string; fps: number }

// Starts (or restarts from `from`) playing `video`; `source` says how to get its frames on this machine
export function play($: EngineInterface, paneId: string, video: string, from: number, box: { width: number; height: number }, source: Source) {
  stopChild($)
  const p: Playback =
    playback?.video === video && playback.site === paneId
      ? { ...playback, status: 'starting', error: '', first: undefined, pending: undefined, isBlitting: false, box }
      : { video, site: paneId, status: 'starting', error: '', position: from, first: undefined, last: undefined, pending: undefined, isBlitting: false, received: 0, shown: 0, dropped: 0, shownLastSecond: 0, box }
  playback = p
  ticker ??= $.clock.every(1000, () => {
    if (playback) {
      playback.shownLastSecond = windowShown
      windowShown = 0
      redraw($)
    }
  })
  const generation = run.generation
  const child = $.process.spawn({ argv: source.argv })
  run.child = child
  if (source.kind === 'files') {
    run.dir = source.dir
  }
  const isCurrent = () => run.generation === generation && playback === p
  void (async () => {
    let buffer = ''
    let stderr = ''
    try {
      for await (const { stream, text } of child) {
        if (stream === 'stderr') {
          stderr = (stderr + text).slice(-400)
          continue
        }
        if (source.kind !== 'helper') {
          continue
        }
        buffer += text
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = parseFrameLine(buffer.slice(0, nl))
          buffer = buffer.slice(nl + 1)
          if (line?.kind === 'frame' && isCurrent()) {
            onFrame($, p, paneId, line.png, from + line.t)
          }
        }
      }
      const end = await child.result.catch(() => undefined)
      if (isCurrent() && source.kind === 'helper') {
        p.status = end?.code === 0 ? 'ended' : 'failed'
        p.error = end?.code === 0 ? '' : stderr.trim()
      }
    } catch (error) {
      if (isCurrent()) {
        p.status = 'failed'
        p.error = String(error).slice(0, 200)
      }
    }
    if (isCurrent()) {
      if (source.kind === 'files') {
        await drainFiles($, p, paneId, source, from, true)
      }
      redraw($)
    }
  })()
  if (source.kind === 'files') {
    let isTaking = false
    run.poll = $.clock.every(Math.round(1000 / source.fps / 2), () => {
      if (isTaking) {
        return
      }
      isTaking = true
      void takeFrames($, p, paneId, source, from, isCurrent).finally(() => {
        isTaking = false
      })
    })
  }
}

// ffmpeg writes frame N while N+1 doesn't exist yet, so all but the newest file are complete
async function takeFrames($: EngineInterface, p: Playback, paneId: string, source: Extract<Source, { kind: 'files' }>, from: number, isCurrent: () => boolean) {
  const files = (await $.fs.list(source.dir).catch(() => [])).map(entry => entry.name).filter(name => name.endsWith('.png')).sort()
  const ready = files.slice(0, -1)
  const newest = ready.at(-1)
  if (!newest || !isCurrent()) {
    return
  }
  const stale = ready.slice(0, -1)
  if (stale.length) {
    p.dropped += stale.length
    await $.process.run(['rm', '-f', ...stale.map(name => `${source.dir}/${name}`)]).catch(() => undefined)
  }
  await showFile($, p, paneId, source, from, Number(newest.replace(/\D/g, '')))
}

async function drainFiles($: EngineInterface, p: Playback, paneId: string, source: Extract<Source, { kind: 'files' }>, from: number, isEnd: boolean) {
  run.poll?.cancel()
  const files = (await $.fs.list(source.dir).catch(() => [])).filter(entry => entry.name.endsWith('.png')).map(entry => entry.name).sort()
  const last = files.at(-1)
  if (last) {
    await showFile($, p, paneId, source, from, Number(last.replace(/\D/g, '')))
  }
  await $.process.run(['rm', '-rf', source.dir]).catch(() => undefined)
  if (isEnd) {
    p.status = p.status === 'failed' ? 'failed' : 'ended'
  }
}

async function showFile($: EngineInterface, p: Playback, paneId: string, source: Extract<Source, { kind: 'files' }>, from: number, at: number) {
  const file = frameFile(source.dir, at)
  const bytes = await $.fs.read(file, { as: 'bytes' }).catch(() => undefined)
  await $.process.run(['rm', '-f', file]).catch(() => undefined)
  const png = typeof bytes === 'object' ? bytes.base64 : undefined
  if (png) {
    onFrame($, p, paneId, png, from + at / source.fps)
  }
}

export function frameFile(dir: string, at: number) {
  return `${dir}/f${String(at).padStart(6, '0')}.png`
}
