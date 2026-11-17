import type { ShowReadImageHistory, ShowReadImageVersion } from '../types'

export const CAP = 10
export const COMPACT = { columns: 100, rows: 25 }
export const EXPANDED = { columns: 255, rows: 60 }
export const WIDE = { columns: 200, rows: 30 }

export type PngFile = { base64: string; dimensions?: Record<string, number | undefined> }

type ReadImage = { type?: string; file?: { base64?: string; type?: string; dimensions?: Record<string, number> } }

// The most an Image takes, decoded
export const MAX_PNG_BYTES = 2 * 1024 * 1024

export function decodedBytes(base64: string) {
  return Math.floor((base64.length * 3) / 4)
}

// A Read result drawn as it is: a PNG small enough for an Image
export function pngOf(tool: string, output: unknown): PngFile | undefined {
  const result = output as ReadImage | undefined
  if (tool !== 'Read' || result?.type !== 'image' || result.file?.type !== 'image/png' || !result.file.base64) {
    return undefined
  }
  if (decodedBytes(result.file.base64) > MAX_PNG_BYTES) {
    return undefined
  }
  return { base64: result.file.base64, dimensions: result.file.dimensions }
}

// A Read result that is an image an Image can't take as it is: another format, or a PNG over 2 MiB
export function otherImageOf(tool: string, output: unknown): (PngFile & { type: string }) | undefined {
  const result = output as ReadImage | undefined
  const type = result?.file?.type ?? ''
  if (tool !== 'Read' || result?.type !== 'image' || !type.startsWith('image/') || !result.file?.base64) {
    return undefined
  }
  if (type === 'image/png' && decodedBytes(result.file.base64) <= MAX_PNG_BYTES) {
    return undefined
  }
  return { base64: result.file.base64, dimensions: result.file.dimensions, type }
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

// A cell's width in pixels where the terminal does not say; close for common fonts at 1x
export const DEFAULT_CELL_WIDTH = 10

// TIOCGWINSZ printed as `rows columns xpixel ypixel`; tmux and some terminals report 0 pixels
export function cellSizeOf(winsize: string): { width: number; height: number } | undefined {
  const [rows = 0, columns = 0, xpixel = 0, ypixel = 0] = winsize.trim().split(/\s+/).map(Number)
  if (!(rows > 0 && columns > 0 && xpixel > 0 && ypixel > 0)) {
    return undefined
  }
  const size = { width: xpixel / columns, height: ypixel / rows }
  const shape = size.height / size.width
  return shape >= 1 && shape <= 4 ? size : undefined
}

// `tmux display -p '#{client_cell_width} #{client_cell_height}'`, for when the pane's tty can't be asked
export function cellFromTmux(text: string): { width: number; height: number } | undefined {
  const [width = 0, height = 0] = text.trim().split(/\s+/).map(Number)
  return width > 0 && height > 0 && height / width >= 1 && height / width <= 4 ? { width, height } : undefined
}

export function cellOf(winsize: string): number | undefined {
  const size = cellSizeOf(winsize)
  return size && size.height / size.width
}

// The widest a picture draws: small ones up to twice their pixels (2× under 400 px, tapering to 1× at 800),
// larger ones at their own size, and never narrower than `floor`
export function nativeColumns(width: number, cellWidth: number, floor = 16) {
  const allowed = Math.max(width, Math.min(2 * width, 800))
  return Math.max(floor, Math.ceil(allowed / cellWidth))
}

export function fit(size: { width: number; height: number }, columns: number, maxRows: number, cell = DEFAULT_CELL, maxColumns = Infinity) {
  let cols = Math.max(1, Math.min(columns, maxColumns))
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
  maxColumns: number[] = [],
): Slot[][] {
  const heightOf = (row: number[]) => {
    const room = width - gap * (row.length - 1)
    const cells = row.reduce((sum, i) => sum + cell * aspects[i]!, 0)
    return Math.min(maxRows, Math.floor(room / cells))
  }
  // Rows are chosen by width alone; then a row is no taller than its smallest picture's own height
  const drawnHeightOf = (row: number[]) => {
    const native = Math.min(...row.map(i => (maxColumns[i] ?? Infinity) / (cell * aspects[i]!)))
    return Math.max(1, Math.min(heightOf(row), Math.floor(native)))
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
    const height = drawnHeightOf(row)
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

// Commands that print paths of files they did not make
const LISTINGS = /^(ls|find|fd|fdfind|rg|grep|tree|du|stat|file|git\s+(status|diff|log|show|ls-files))\b/

export type CommandKind = 'listing' | 'other'

// The first real command of the line decides, after env assignments and a leading cd ... &&
export function commandKind(command: string): CommandKind {
  const first =
    command
      .split(/&&|\|\||;|\|/)
      .map(part => part.trim().replace(/^(\w+=\S*\s+)+/, ''))
      .find(part => part && !/^cd\s/.test(part) && !/^\w+=\S*$/.test(part)) ?? ''
  return LISTINGS.test(first) ? 'listing' : 'other'
}

const PATH_IN_TEXT = /(?:^|[\s"'=(:])(\/[^\s"'()<>]+?\.(?:png|jpe?g|mov|mp4|m4v))(?=$|[\s"'),;<>])/gi
const IMAGE_PATH = /^\/.+\.(png|jpe?g|mov|mp4|m4v)$/i

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

// Image paths a tool call printed, taking a JSON result's full image over its thumbnail; a listing's are not its own
export function imagePathsIn(output: string, command?: string): string[] {
  if (command !== undefined && commandKind(command) === 'listing') {
    return []
  }
  const fromJson = jsonPaths(output.trim())
  const printed = fromJson.length > 0 ? fromJson : [...output.matchAll(PATH_IN_TEXT)].map(m => m[1]!)
  return [...new Set(printed)].slice(0, MAX_TOOL_CARDS)
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

// Videos

export function isVideoPath(path: string) {
  return /\.(mov|mp4|m4v)$/i.test(path)
}

// `samples`: when each of the grid's frames is from, where the frames themselves aren't stamped with it
export type VideoStats = { duration: number; frames: number; gap: number; gapAt: number; samples?: number[] }

// Clips longer than this are sampled by seeking to each frame instead of decoding the whole video
export const SEEK_ABOVE_SECONDS = 60

// Where the grid's frames come from: the fps filter starts at 0; seeks take the middle of each eighth
export function sampleTimes(duration: number, count: number, isSeeking: boolean) {
  return Array.from({ length: count }, (_, k) => ((k + (isSeeking ? 0.5 : 0)) * duration) / count)
}

// Whole seconds where every time is whole, else one decimal: rounding 7.5 to 8 would place a frame half a second late
export function samplesRow(samples: number[]) {
  const isWhole = samples.every(t => Math.abs(t - Math.round(t)) < 0.05)
  return `frames at ${samples.map(t => t.toFixed(isWhole ? 0 : 1)).join(' ')} s`
}

// The longest wait between two frames: a screen recording only stores a frame when something changed, so a long
// gap during an animation is a hitch
export function longestGap(times: number[]): { gap: number; gapAt: number } {
  const sorted = [...times].sort((a, b) => a - b)
  let gap = 0
  let gapAt = 0
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - sorted[i - 1]! > gap) {
      gap = sorted[i]! - sorted[i - 1]!
      gapAt = sorted[i]!
    }
  }
  return { gap, gapAt }
}

// A time in a clip as m:ss.s, or m:ss where `whole`
export function clockOf(t: number, whole = false) {
  const minutes = Math.floor(t / 60)
  const rest = t - minutes * 60
  return `${minutes}:${(whole ? Math.floor(rest).toString() : rest.toFixed(1)).padStart(whole ? 2 : 4, '0')}`
}

// The clip in words: its length and frames, and where it held still longest when that was over half a second
export function videoNote(stats: VideoStats) {
  const hold = stats.gap >= 0.5 ? ` · longest hold ${stats.gap.toFixed(1)} s at ${clockOf(stats.gapAt)}` : ''
  return `${clockOf(stats.duration)} · ${stats.frames} frames${hold}`
}

// Eight frames: four across for a tall video, two across for a wide one
export function stripLayout(width: number, height: number) {
  const isTall = height >= width
  return isTall ? { columns: 4, rows: 2, cellHeight: 480 } : { columns: 2, rows: 4, cellHeight: 270 }
}

// Live playback

// A line from the frame helper: `FRAME <t> <base64 png>`, `META {…}` or `END <count>`
export function parseFrameLine(line: string): { kind: 'frame'; t: number; png: string } | { kind: 'end' } | undefined {
  if (line.startsWith('FRAME ')) {
    const space = line.indexOf(' ', 6)
    const t = Number(line.slice(6, space))
    const png = line.slice(space + 1)
    return space > 6 && Number.isFinite(t) && png ? { kind: 'frame', t, png } : undefined
  }
  return line.startsWith('END') ? { kind: 'end' } : undefined
}

// The pixel box frames are decoded into: the pane's cells, short of the rows its controls take
export function playerBox(columns: number, rows: number, cellWidth: number, cell: number, controlRows = 2) {
  const cellHeight = cellWidth * cell
  return { width: Math.max(64, Math.round(columns * cellWidth)), height: Math.max(64, Math.round((rows - controlRows) * cellHeight)) }
}

// The player's word for where the clip is
export function playWord(state: 'playing' | 'paused' | 'ended' | 'idle', position: number) {
  if (state === 'playing') {
    return '❚❚ Pause'
  }
  if (state === 'ended') {
    return '↺ Replay'
  }
  return state === 'paused' && position > 0 ? '▶ Resume' : '▶ Play'
}

// A scrub bar of `segments` cells in about `count` pressable stretches: played '━', the playhead '●', the rest '─'
export function scrubChunks(segments: number, playhead: number, count = 20) {
  const size = Math.max(1, Math.ceil(segments / count))
  const chunks: { start: number; label: string; isAhead: boolean }[] = []
  for (let start = 0; start < segments; start += size) {
    let label = ''
    for (let i = start; i < Math.min(segments, start + size); i++) {
      label += i === playhead ? '●' : i < playhead ? '━' : '─'
    }
    chunks.push({ start, label, isAhead: start > playhead })
  }
  return chunks
}
