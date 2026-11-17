import type { EngineInterface } from 'claude-code'

import { SEEK_ABOVE_SECONDS, longestGap, sampleTimes, stripLayout } from './logic'
import type { VideoStats } from './logic'
import type { Source } from './player'

// Image tools this machine has, looked up once a session: sips on macOS, ImageMagick or ffmpeg elsewhere
type Converter = 'sips' | 'magick' | 'convert' | 'ffmpeg'

let found: Promise<Converter | undefined> | undefined

export function converter($: EngineInterface): Promise<Converter | undefined> {
  found ??= (async () => {
    for (const name of ['sips', 'magick', 'convert', 'ffmpeg'] as const) {
      const ran = await $.process.run(['sh', '-c', `command -v ${name}`]).catch(() => undefined)
      if (ran?.exitCode === 0 && ran.stdout.trim()) {
        return name
      }
    }
    return undefined
  })()
  return found
}

function argv(tool: Converter, from: string, to: string, side: number): string[] {
  switch (tool) {
    case 'sips':
      return ['sips', '-s', 'format', 'png', '-Z', String(side), from, '--out', to]
    case 'magick':
    case 'convert':
      // 8 bits a channel: a 16-bit source would otherwise stay twice the size
      return [tool, from, '-resize', `${side}x${side}>`, '-depth', '8', `png:${to}`]
    case 'ffmpeg':
      return ['ffmpeg', '-v', 'error', '-y', '-i', from, '-frames:v', '1', '-vf',
        `scale=w=min(${side}\\,iw):h=min(${side}\\,ih):force_original_aspect_ratio=decrease`, '-pix_fmt', 'rgb24', to]
  }
}

// Writes a PNG of `from` with its longest side at most `side` pixels; false when no tool here can
export async function toPng($: EngineInterface, from: string, to: string, side: number): Promise<boolean> {
  const tool = await converter($)
  if (!tool) {
    return false
  }
  const ran = await $.process.run(argv(tool, from, to, side), { timeoutMs: 60_000 }).catch(() => undefined)
  return ran?.exitCode === 0
}

// Writes base64 bytes to a file; $.fs.write takes text only
export async function writeBytes($: EngineInterface, path: string, base64: string): Promise<boolean> {
  const ran = await $.process.run(['sh', '-c', 'base64 -d > "$1"', 'sh', path], { stdin: base64 }).catch(() => undefined)
  return ran?.exitCode === 0
}

// Videos: a grid of eight timed frames and the clip's frame timing, by AVFoundation on macOS (a Swift helper
// compiled once into the cache) or ffmpeg and ffprobe elsewhere

type StripTool = 'swift' | 'ffmpeg'

let stripTool: Promise<StripTool | undefined> | undefined

async function has($: EngineInterface, name: string) {
  const ran = await $.process.run(['sh', '-c', `command -v ${name}`]).catch(() => undefined)
  return ran?.exitCode === 0 && ran.stdout.trim() !== ''
}

function videoTool($: EngineInterface): Promise<StripTool | undefined> {
  stripTool ??= (async () => {
    const os = (await $.process.run(['uname', '-s']).catch(() => undefined))?.stdout.trim()
    if (os === 'Darwin' && (await has($, 'swiftc'))) {
      return 'swift'
    }
    return (await has($, 'ffmpeg')) && (await has($, 'ffprobe')) ? 'ffmpeg' : undefined
  })()
  return stripTool
}

async function swiftStrip($: EngineInterface, video: string, out: string, cache: string): Promise<VideoStats | undefined> {
  const bin = `${cache}/filmstrip`
  if (!(await $.fs.exists(bin))) {
    const built = await $.process.run(['swiftc', '-O', '-swift-version', '5', `${$.plugin.root}/hooks/filmstrip.swift`, '-o', bin], { timeoutMs: 300_000 })
    if (built.exitCode !== 0) {
      return undefined
    }
  }
  const ran = await $.process.run([bin, video, out, '8'], { timeoutMs: 180_000 })
  if (ran.exitCode !== 0) {
    return undefined
  }
  try {
    return JSON.parse(ran.stdout.trim().split('\n').pop() ?? '') as VideoStats
  } catch {
    return undefined
  }
}

async function ffmpegStrip($: EngineInterface, video: string, out: string): Promise<VideoStats | undefined> {
  const probe = (args: string[]) => $.process.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', ...args, '-of', 'csv=p=0', video], { timeoutMs: 120_000 })
  const shape = await probe(['-show_entries', 'stream=width,height'])
  const [width = 0, height = 0] = shape.stdout.trim().split(',').map(Number)
  const packets = await probe(['-show_entries', 'packet=pts_time'])
  // Blank lines (the trailing newline) would read as 0 s and count as frames
  const times = packets.stdout.split('\n').filter(line => line.trim() !== '').map(Number).filter(t => Number.isFinite(t) && t >= 0)
  const duration = Number((await $.process.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video])).stdout.trim())
  if (!width || !height || !(duration > 0) || times.length === 0) {
    return undefined
  }
  const grid = stripLayout(width, height)
  const count = grid.columns * grid.rows
  const tile = `tile=${grid.columns}x${grid.rows}:padding=12:margin=12:color=0x17171a`
  const isSeeking = duration > SEEK_ABOVE_SECONDS
  const samples = sampleTimes(duration, count, isSeeking)
  const made = isSeeking
    ? await seekStrip($, video, out, samples, `scale=-2:${grid.cellHeight}`, tile)
    : await $.process.run(
        ['ffmpeg', '-v', 'error', '-y', '-i', video, '-vf', `fps=${count / duration},scale=-2:${grid.cellHeight},${tile}`, '-frames:v', '1', '-pix_fmt', 'rgb24', out],
        { timeoutMs: 180_000 },
      )
  return made.exitCode === 0 ? { duration, frames: times.length, ...longestGap(times), samples } : undefined
}

// One seek per frame, each decoding only from the key frame before it, then the frames tiled into the grid
async function seekStrip($: EngineInterface, video: string, out: string, samples: number[], scale: string, tile: string) {
  const frame = (k: number) => `${out}-frame-${k}.png`
  try {
    for (const [k, t] of samples.entries()) {
      const one = await $.process.run(['ffmpeg', '-v', 'error', '-y', '-ss', t.toFixed(3), '-i', video, '-frames:v', '1', '-vf', scale, frame(k)], { timeoutMs: 60_000 })
      if (one.exitCode !== 0) {
        return one
      }
    }
    return await $.process.run(
      ['ffmpeg', '-v', 'error', '-y', '-start_number', '0', '-i', `${out}-frame-%d.png`, '-vf', tile, '-frames:v', '1', '-pix_fmt', 'rgb24', out],
      { timeoutMs: 60_000 },
    )
  } finally {
    await $.process.run(['rm', '-f', ...samples.map((_, k) => frame(k))]).catch(() => undefined)
  }
}

// Writes the grid to `out` and returns the clip's timing, or undefined when this machine has neither tool
export async function filmstrip($: EngineInterface, video: string, out: string, cache: string): Promise<VideoStats | undefined> {
  const tool = await videoTool($)
  if (tool === 'swift') {
    return swiftStrip($, video, out, cache)
  }
  return tool === 'ffmpeg' ? ffmpegStrip($, video, out) : undefined
}

export async function openExternally($: EngineInterface, path: string) {
  const os = (await $.process.run(['uname', '-s']).catch(() => undefined))?.stdout.trim()
  await $.process.run([os === 'Darwin' ? 'open' : 'xdg-open', path]).catch(() => undefined)
}

// Where live frames come from: the Objective-C helper on macOS (AVFoundation; Swift can't stream stdout as simply),
// compiled with clang on first use, or ffmpeg writing frames to files in real time elsewhere
export async function playbackSource(
  $: EngineInterface,
  video: string,
  box: { width: number; height: number },
  from: number,
  fps: number,
  cache: string,
): Promise<Source | undefined> {
  const os = (await $.process.run(['uname', '-s']).catch(() => undefined))?.stdout.trim()
  if (os === 'Darwin' && (await has($, 'clang'))) {
    const bin = `${cache}/framestream`
    if (!(await $.fs.exists(bin))) {
      const frameworks = ['Foundation', 'AVFoundation', 'CoreMedia', 'CoreVideo', 'VideoToolbox', 'ImageIO', 'CoreGraphics'].flatMap(name => ['-framework', name])
      const built = await $.process.run(['clang', '-O2', '-fobjc-arc', ...frameworks, `${$.plugin.root}/hooks/framestream.m`, '-o', bin], { timeoutMs: 120_000 })
      if (built.exitCode !== 0) {
        return undefined
      }
    }
    return { kind: 'helper', argv: [bin, video, String(box.width), String(box.height), String(fps), from.toFixed(3)] }
  }
  if (!(await has($, 'ffmpeg'))) {
    return undefined
  }
  // One playback at a time, so any play-* folder left by a crash or a killed session is stale
  await $.process.run(['sh', '-c', 'rm -rf "$1"/play-*', 'sh', cache]).catch(() => undefined)
  const dir = `${cache}/play-${Date.now().toString(36)}`
  await $.process.run(['mkdir', '-p', dir])
  const scale = `fps=${fps},scale=w=${box.width}:h=${box.height}:force_original_aspect_ratio=decrease`
  return {
    kind: 'files',
    dir,
    fps,
    argv: ['ffmpeg', '-v', 'error', '-re', '-ss', from.toFixed(3), '-i', video, '-vf', scale, '-pix_fmt', 'rgb24', '-f', 'image2', '-start_number', '0', `${dir}/f%06d.png`],
  }
}
