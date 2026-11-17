import type { EngineInterface } from 'claude-code'

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
