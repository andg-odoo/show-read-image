import type { ShowReadImageHistory, ShowReadImageVersion } from '../types'

export const CAP = 10
export const COMPACT = { columns: 100, rows: 25 }
export const EXPANDED = { columns: 255, rows: 60 }
export const WIDE = { columns: 200, rows: 30 }

export type PngFile = { base64: string; dimensions?: Record<string, number | undefined> }

type ReadImage = { type?: string; file?: { base64?: string; type?: string; dimensions?: Record<string, number> } }

export function pngOf(tool: string, output: unknown): PngFile | undefined {
  const result = output as ReadImage | undefined
  if (tool !== 'Read' || result?.type !== 'image' || result.file?.type !== 'image/png' || !result.file.base64) {
    return undefined
  }
  return { base64: result.file.base64, dimensions: result.file.dimensions }
}

export function pathOf(input: unknown): string {
  const path = (input as { file_path?: unknown } | undefined)?.file_path
  return typeof path === 'string' ? path : ''
}

export function isPngPath(path: string) {
  return /\.png$/i.test(path)
}

export function splitPath(path: string) {
  const cut = path.lastIndexOf('/')
  const name = path.slice(cut + 1)
  return { dir: cut < 0 ? '' : path.slice(0, cut), name, stem: name.replace(/\.png$/i, '') }
}

// `x.after.png` pairs with `x.before.png` in the same folder
export function pairOf(path: string) {
  const match = /^(.*)\.(before|after)\.png$/i.exec(path)
  if (!match) {
    return undefined
  }
  const base = match[1]!
  return {
    side: match[2]!.toLowerCase() as 'before' | 'after',
    stem: splitPath(base).stem,
    before: `${base}.before.png`,
    after: `${base}.after.png`,
  }
}

// Two FNV-1a lanes over the base64 text, enough to tell versions of one file apart
export function hashOf(text: string) {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x050c5d1f)
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

// A cheap key for drawing, from the length and three samples of the text
export function fingerprint(text: string) {
  const at = (part: number) => text.slice(Math.floor(text.length * part), Math.floor(text.length * part) + 64)
  return hashOf(`${text.length}:${at(0.25)}:${at(0.5)}:${at(0.75)}`)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Width and height from the PNG's IHDR chunk, bytes 16 to 23 of the file
export function pngSize(base64: string): { width: number; height: number } | undefined {
  const head = base64.slice(0, 32)
  const bytes: number[] = []
  for (let i = 0; i + 3 < head.length; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | Math.max(0, B64.indexOf(head[i + k]!)), 0)
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  if (bytes.length < 24 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    return undefined
  }
  const word = (at: number) => ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  const size = { width: word(16), height: word(20) }
  return size.width > 0 && size.height > 0 ? size : undefined
}

export function sizeOf(file: PngFile) {
  const own = pngSize(file.base64)
  const width = file.dimensions?.originalWidth ?? own?.width ?? 1600
  const height = file.dimensions?.originalHeight ?? own?.height ?? 1000
  return { width, height }
}

// A cell's height over its width; most fonts are close to 2 when the terminal reports no pixel size
export const DEFAULT_CELL = 2

// TIOCGWINSZ printed as `rows columns xpixel ypixel`; tmux and some terminals report 0 pixels
export function cellOf(winsize: string): number | undefined {
  const [rows = 0, columns = 0, xpixel = 0, ypixel = 0] = winsize.trim().split(/\s+/).map(Number)
  if (!(rows > 0 && columns > 0 && xpixel > 0 && ypixel > 0)) {
    return undefined
  }
  const cell = ypixel / rows / (xpixel / columns)
  return cell >= 1 && cell <= 4 ? cell : undefined
}

export function fit(size: { width: number; height: number }, columns: number, maxRows: number, cell = DEFAULT_CELL) {
  let cols = Math.max(1, columns)
  let rows = Math.max(1, Math.round((cols * size.height) / size.width / cell))
  if (rows > maxRows) {
    rows = maxRows
    cols = Math.max(1, Math.min(columns, Math.round((rows * cell * size.width) / size.height)))
  }
  return { columns: cols, rows }
}

export type Slot = { index: number; columns: number; rows: number }

// Packs pictures into rows of one height, a new row once a picture would drop below minRows
export function pack(
  aspects: number[],
  width: number,
  maxRows: number,
  minRows = 6,
  perRow = Infinity,
  gap = 2,
  cell = DEFAULT_CELL,
): Slot[][] {
  const heightOf = (row: number[]) => {
    const room = width - gap * (row.length - 1)
    const cells = row.reduce((sum, i) => sum + cell * aspects[i]!, 0)
    return Math.min(maxRows, Math.floor(room / cells))
  }
  const rows: number[][] = []
  let current: number[] = []
  aspects.forEach((_, i) => {
    if (current.length >= perRow || (current.length > 0 && heightOf([...current, i]) < minRows)) {
      rows.push(current)
      current = []
    }
    current.push(i)
  })
  if (current.length > 0) {
    rows.push(current)
  }
  return rows.map(row => {
    const height = Math.max(1, heightOf(row))
    return row.map(index => ({
      index,
      rows: height,
      columns: Math.max(1, Math.min(width, Math.round(height * cell * aspects[index]!))),
    }))
  })
}

// The history after a read of `hash`: same content already kept means no new version
export function addVersion(entry: ShowReadImageHistory | undefined, hash: string, at: number) {
  const current = entry ?? { seq: 0, versions: [] }
  if (current.versions.some(one => one.hash === hash)) {
    return undefined
  }
  const version: ShowReadImageVersion = { hash, at, slot: current.seq % CAP }
  return { version, entry: { seq: current.seq + 1, versions: [...current.versions, version].slice(-CAP) } }
}

export function historyDir(home: string, path: string) {
  return `${home}/.cache/show-read-image/${splitPath(path).stem}-${hashOf(path).slice(0, 6)}`
}

// Warns when two shots differ by more than 10% in aspect, so they are not comparable
export function sizeWarning(a: { width: number; height: number }, b: { width: number; height: number }) {
  const ratio = a.width / a.height / (b.width / b.height)
  return Math.abs(ratio - 1) > 0.1 ? `sizes differ (${pixels(a)} vs ${pixels(b)})` : ''
}

export function pixels(size: { width: number; height: number }) {
  return `${size.width}×${size.height}`
}

// Images other tools produce

export const MAX_TOOL_CARDS = 4

// Commands that write an image without printing its path; their image arguments are what they made
const MAKERS = /^(screencapture|sips|magick|convert|ffmpeg|rsvg-convert|xcrun\s+simctl\s+io\b.*\bscreenshot|simctl\s+io\b.*\bscreenshot|import|grim|scrot|maim)\b/
// Commands that print paths of files they did not make
const LISTINGS = /^(ls|find|fd|fdfind|rg|grep|tree|du|stat|file|git\s+(status|diff|log|show|ls-files))\b/

export type CommandKind = 'maker' | 'listing' | 'other'

// The first command of the line decides, after env assignments and a leading cd ... &&
export function commandKind(command: string): CommandKind {
  const first = command
    .split(/&&|\|\||;|\|/)
    .map(part => part.trim().replace(/^(\w+=\S*\s+)+/, ''))
    .find(part => part && !/^cd\s/.test(part)) ?? ''
  if (MAKERS.test(first)) {
    return 'maker'
  }
  return LISTINGS.test(first) ? 'listing' : 'other'
}

const PATH_IN_TEXT = /(?:^|[\s"'=(:])(\/[^\s"'()<>]+?\.(?:png|jpe?g))(?=$|[\s"'),;<>])/gi
const IMAGE_PATH = /^\/.+\.(png|jpe?g)$/i
const IMAGE_FILE = /\.(png|jpe?g)$/i

// A JSON result names paths whose keys say what they are; a thumbnail beside a full image is a duplicate
function jsonPaths(text: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const hits: { key: string; path: string }[] = []
  const walk = (value: unknown, key: string, depth: number) => {
    if (depth > 5) {
      return
    }
    if (typeof value === 'string' && IMAGE_PATH.test(value)) {
      hits.push({ key, path: value })
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        walk(v, k, depth + 1)
      }
    }
  }
  walk(parsed, '', 0)
  const full = hits.filter(hit => !/thumb/i.test(hit.key))
  return (full.length > 0 ? full : hits).map(hit => hit.path)
}

// The directory a command runs in after a leading `cd DIR &&`
function workingDir(command: string, base: string, home: string) {
  const cd = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/.exec(command)?.[1]?.replace(/^["']|["']$/g, '')
  return cd ? absolute(cd, base, home) : base
}

function absolute(token: string, base: string, home: string) {
  if (token.startsWith('/')) {
    return token
  }
  if (token === '~' || token.startsWith('~/')) {
    return home + token.slice(1)
  }
  return `${base.replace(/\/$/, '')}/${token.replace(/^\.\//, '')}`
}

// Image paths a tool call made: printed in its output, or, for an image-making command, the image it wrote,
// which is its last image argument (`sips in.png --out out.png`, `magick in.jpg out.png`)
export function imagePathsIn(output: string, command?: string, base = '/', home = '/'): string[] {
  const kind = command === undefined ? 'other' : commandKind(command)
  const fromJson = jsonPaths(output.trim())
  const printed = kind === 'listing' ? [] : fromJson.length > 0 ? fromJson : [...output.matchAll(PATH_IN_TEXT)].map(m => m[1]!)
  const made =
    kind === 'maker'
      ? (command ?? '')
          .split(/\s+/)
          .map(token => token.replace(/^["']|["']$/g, ''))
          .filter(token => IMAGE_FILE.test(token) && !token.includes('$'))
          .slice(-1)
          .map(token => absolute(token, workingDir(command ?? '', base, home), home))
      : []
  return [...new Set([...printed, ...made])].slice(0, MAX_TOOL_CARDS)
}

export type ImageBlock = { base64: string; mime: string }

// Inline image blocks in a tool's result, as MCP servers return them
export function imageBlocks(result: unknown, found: ImageBlock[] = [], depth = 0): ImageBlock[] {
  if (depth > 5 || found.length >= MAX_TOOL_CARDS || result === null || typeof result !== 'object') {
    return found
  }
  if (Array.isArray(result)) {
    for (const item of result) {
      imageBlocks(item, found, depth + 1)
    }
    return found
  }
  const record = result as Record<string, unknown>
  if (record.type === 'image') {
    const source = record.source as Record<string, unknown> | undefined
    const data = typeof record.data === 'string' ? record.data : typeof source?.data === 'string' ? source.data : undefined
    if (data) {
      found.push({ base64: data, mime: String(record.mimeType ?? source?.media_type ?? 'image/png') })
      return found
    }
  }
  for (const value of Object.values(record)) {
    imageBlocks(value, found, depth + 1)
  }
  return found
}

export function isPng(base64: string) {
  return base64.startsWith('iVBORw0KGgo')
}
