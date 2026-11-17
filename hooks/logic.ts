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

// A terminal cell is about twice as tall as it is wide
export function fit(size: { width: number; height: number }, columns: number, maxRows: number) {
  let cols = Math.max(1, columns)
  let rows = Math.max(1, Math.round((cols * size.height) / size.width / 2))
  if (rows > maxRows) {
    rows = maxRows
    cols = Math.max(1, Math.min(columns, Math.round((rows * 2 * size.width) / size.height)))
  }
  return { columns: cols, rows }
}

export type Slot = { index: number; columns: number; rows: number }

// Packs pictures into rows of one height, a new row once a picture would drop below minRows
export function pack(aspects: number[], width: number, maxRows: number, minRows = 6, perRow = Infinity, gap = 2): Slot[][] {
  const heightOf = (row: number[]) => {
    const room = width - gap * (row.length - 1)
    const cells = row.reduce((sum, i) => sum + 2 * aspects[i]!, 0)
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
      columns: Math.max(1, Math.min(width, Math.round(height * 2 * aspects[index]!))),
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
