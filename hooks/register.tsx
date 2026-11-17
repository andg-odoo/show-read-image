import { atom, memberOf, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, ToolGroupCall } from 'claude-code'

import type { ShowReadImageCard, ShowReadImageCardShot, ShowReadImageExpanded, ShowReadImageHistory, ShowReadImageMode, ShowReadImageView } from '../types'
import {
  COMPACT,
  EXPANDED,
  WIDE,
  addVersion,
  cellFromTmux,
  cellSizeOf,
  fingerprint,
  fit,
  hashOf,
  historyDir,
  imageBlocks,
  imagePathsIn,
  isPng,
  isPngPath,
  nativeColumns,
  pack,
  pairOf,
  otherImageOf,
  pathOf,
  pixels,
  pngOf,
  pngSize,
  sizeOf,
  sizeWarning,
  splitPath,
} from './logic'
import type { PngFile } from './logic'
import { toPng, writeBytes } from './platform'

type Ui = Elements['terminal']
type Box = { columns: number; rows: number }
type Size = { width: number; height: number }
type Shot = { title: string; meta: string; base64: string; size: Size; key?: string }
type Read = { id: string; path: string; file: PngFile }
type Pic = { base64: string; size: Size }
type Pair = { stem: string; hint: string; before: Pic; after: Pic }

const history = atom({ plugin: 'show-read-image', key: 'history' } as const, {}, { shape: 'history-1' })
const step = atom({ plugin: 'show-read-image', key: 'step' } as const, -1)
const mode = atom({ plugin: 'show-read-image', key: 'mode' } as const, 'both' as ShowReadImageMode)
const view = atom({ plugin: 'show-read-image', key: 'view' } as const, 'now' as ShowReadImageView)
// A compare card's choice: -1 all; with two pictures, which one alone; with more, which one beside the first
const pick = atom({ plugin: 'show-read-image', key: 'pick' } as const, -1)
// When each `path#hash` was last shown by a Read, so a command's card for the same picture can fold away
const seen = atom({ plugin: 'show-read-image', key: 'seen' } as const, {} as Record<string, number>, { shape: 'seen-1' })
const MAX_SEEN = 500
const PANE = 'show-read-image'
// The picture the Expand pane shows; its bytes stay in memory, or come from the history store by `key`
const expanded = atom({ plugin: 'show-read-image', key: 'expanded' } as const, null as ShowReadImageExpanded | null, { shape: 'expanded-1' })
const expandedBytes = new Map<string, string>()
const cards = atom({ plugin: 'show-read-image', key: 'cards' } as const, {} as Record<string, ShowReadImageCard>, { shape: 'cards-1' })

const MIN_FRAME = 30
const MAX_SIDE = 6
const MAX_CARDS_KEPT = 200
// Our own tools draw their own cards; computer-use screenshots are the agent's working view; the rest name
// files they found or touched, not images they made
const SKIP_TOOLS = /^(Read|Glob|Grep|LS|Edit|MultiEdit|Write|NotebookRead|NotebookEdit|WebFetch|WebSearch)$|^mcp__(show-read-image|computer-use)__/
const UNREAD = 'not read by the agent'
// The session's tty size in cells and pixels; a hook process has no tty of its own, so it opens /dev/tty
const WINSIZE = `perl -e 'open(T, "</dev/tty") or exit 1; my $w = " " x 8; ioctl(T, ($^O eq "darwin" ? 0x40087468 : 0x5413), $w) or exit 1; print join(" ", unpack("S4", $w))'`
// Andrew's Ghostty font, measured in tmux 3.4; used only when the terminal can't be asked
const FALLBACK_CELL = { width: 10, height: 21 }
const MAX_PNG = 2 * 1024 * 1024
const UNKNOWN = { width: 16, height: 10 }
const MODES: { mode: ShowReadImageMode; label: string }[] = [
  { mode: 'both', label: 'side by side' },
  { mode: 'after', label: 'after only' },
  { mode: 'before', label: 'before only' },
]

// Caches only spare work, a reload that empties them costs a re-read
const hashes = new Map<string, string>()
const paths = new Map<string, string>()
const mates = new Map<string, string[]>()
const versionBytes = new Map<string, string>()
const diskBytes = new Map<string, { mtimeMs: number; base64: string }>()
let home: string | undefined
let cell = FALLBACK_CELL.height / FALLBACK_CELL.width
let cellWidth = FALLBACK_CELL.width
let viewRows = 40
const MAX_CACHED = 24

// Keeps the most recently used few; each entry can hold a couple of MB of base64
function remember<K, V>(map: Map<K, V>, key: K, value: V) {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_CACHED) {
    map.delete(map.keys().next().value as K)
  }
}
let measuredFor = ''
let measuredOnce: string | undefined

// The pane's tty through /dev/tty; a hook's process may have none (seen in tmux on Linux), so tmux is asked next
async function askCell($: EngineInterface): Promise<{ size: { width: number; height: number }; from: string } | undefined> {
  const ran = await $.process.run(['sh', '-c', WINSIZE]).catch(() => undefined)
  const own = ran?.exitCode === 0 ? cellSizeOf(ran.stdout) : undefined
  if (own) {
    return { size: own, from: 'tty' }
  }
  if (!(await $.env.get('TMUX').catch(() => undefined))) {
    return undefined
  }
  const tmux = await $.process.run(['tmux', 'display', '-p', '#{client_cell_width} #{client_cell_height}']).catch(() => undefined)
  const asked = tmux?.exitCode === 0 ? cellFromTmux(tmux.stdout) : undefined
  return asked && { size: asked, from: 'tmux' }
}

// Once per viewport size: the cell shape changes with the font, not with every draw
async function measure($: EngineInterface, viewport: { columns: number; rows: number } | undefined) {
  const key = `${viewport?.columns}x${viewport?.rows}`
  if (measuredFor === key) {
    return
  }
  measuredFor = key
  viewRows = viewport?.rows ?? viewRows
  const found = await askCell($)
  const size = found?.size ?? FALLBACK_CELL
  const next = size.height / size.width
  const width = size.width
  if (measuredOnce !== (found?.from ?? 'fallback')) {
    measuredOnce = found?.from ?? 'fallback'
    const log = `${await homeOf($)}/.cache/show-read-image/cell.txt`
    await $.fs.write(log, `${measuredOnce} ${size.width}x${size.height}\n`).catch(() => undefined)
  }
  if (next !== cell || width !== cellWidth) {
    cell = next
    cellWidth = width
    $.ui.invalidate('ui.render')
  }
}

function hashFor(id: string, base64: string) {
  const key = `${id}:${base64.length}`
  let hash = hashes.get(key)
  if (hash === undefined) {
    hash = hashOf(base64)
    hashes.set(key, hash)
  }
  return hash
}

async function homeOf($: EngineInterface) {
  home ??= await $.env.get('HOME').catch(() => undefined)
  return home ?? '/tmp'
}

async function kept($: EngineInterface) {
  return (await read($, history)) as Record<string, ShowReadImageHistory>
}

// Versions are stored by content; `slot` finds ones written by 0.3, which stored them in a ring of slots
async function readVersion($: EngineInterface, path: string, slot: number, hash: string) {
  const dir = historyDir(await homeOf($), path)
  const key = `${dir}:${hash}`
  let base64 = versionBytes.get(key)
  if (base64 === undefined) {
    for (const file of [`${dir}/${hash}.b64`, ...(slot >= 0 ? [`${dir}/${slot}.b64`] : [])]) {
      const text = String(await $.fs.read(file).catch(() => ''))
      if (text && hashOf(text) === hash) {
        base64 = text
        break
      }
    }
    if (base64 === undefined) {
      return undefined
    }
  }
  remember(versionBytes, key, base64)
  return base64
}

async function readDisk($: EngineInterface, path: string) {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat || stat.kind !== 'file' || stat.size > MAX_PNG) {
    return undefined
  }
  const cached = diskBytes.get(path)
  if (cached?.mtimeMs === stat.mtimeMs) {
    return cached.base64
  }
  const bytes = await $.fs.read(path, { as: 'bytes' }).catch(() => undefined)
  const base64 = typeof bytes === 'object' ? bytes.base64 : undefined
  if (base64) {
    remember(diskBytes, path, { mtimeMs: stat.mtimeMs, base64 })
  }
  return base64
}

async function record($: EngineInterface, path: string, base64: string) {
  const hash = hashOf(base64)
  const added = addVersion((await kept($))[path], hash, await $.clock.now())
  if (!added) {
    return
  }
  const dir = historyDir(await homeOf($), path)
  await $.fs.write(`${dir}/${hash}.b64`, base64)
  let dropped: string[] = []
  const all = await update($, history, before => {
    const again = addVersion(before[path], hash, added.version.at)
    if (!again) {
      return before
    }
    const now = new Set(again.entry.versions.map(one => one.hash))
    dropped = (before[path]?.versions ?? []).map(one => one.hash).filter(old => !now.has(old))
    return { ...before, [path]: again.entry }
  })
  await $.store.set('history', all)
  const held = new Set(Object.values(await read($, cards)).flatMap(card => card.shots.filter(one => one.key === path).map(one => one.hash)))
  const gone = dropped.filter(old => !held.has(old)).map(old => `${dir}/${old}.b64`)
  if (gone.length > 0) {
    await $.process.run(['rm', '-f', ...gone]).catch(() => undefined)
  }
}

// A card stays within most of the visible rows, so its title and controls are on screen with it
function tallest(max: number) {
  return Math.max(8, Math.min(max, Math.floor(viewRows * 0.6)))
}

function room(columns: number | undefined, isExpanded?: boolean): Box {
  const max = isExpanded ? EXPANDED : COMPACT
  return { columns: Math.max(20, Math.min(max.columns, (columns ?? 120) - 8)), rows: tallest(max.rows) }
}

// Galleries and pairs take the transcript's width, two pictures a row
function wide(columns: number | undefined): Box {
  return { columns: Math.max(20, Math.min(WIDE.columns, (columns ?? 120) - 8)), rows: tallest(WIDE.rows) }
}

function clock(at: number) {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function hintOf(path: string) {
  const { dir } = splitPath(path)
  return dir ? `${splitPath(dir).name}/` : ''
}

type FrameAt = { title: string; hint?: string; meta: string; width: number; controls?: number; max: number; actions?: JSX.Element[] }

// Bracketed buttons draw as `[ label ]`, one column apart
function buttonsWidth(labels: string[]) {
  return labels.reduce((sum, label) => sum + label.length + 4, 0) + Math.max(0, labels.length - 1)
}

// As wide as its widest line, picture, header or controls, so none of them is crushed; pictures keep their own size
function frameWidth(at: FrameAt) {
  const header = at.title.length + (at.hint ? at.hint.length + 1 : 0) + 2 + at.meta.length + (at.actions?.length ?? 0) * 2
  return Math.min(at.max, Math.max(MIN_FRAME, at.width, header, at.controls ?? 0))
}

// Control groups wrap as wholes, so `◀ v3/3 ▶` or a button never breaks apart
function Controls(ui: Ui, ...groups: JSX.Element[][]) {
  const { Box } = ui
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
      {groups.map((group, i) => (
        <Box key={`controls-${i}`} flexDirection="row" gap={1} flexShrink={0}>
          {group}
        </Box>
      ))}
    </Box>
  )
}

// Opens the Expand pane on this picture; `key` lets it step through the picture's versions
function ExpandButton($: EngineInterface, ui: Ui, id: string, label: string, base64: string, key?: string, size?: Size) {
  const hash = hashOf(base64)
  const own = size ? { width: size.width, height: size.height } : {}
  return (
    <ui.Button
      key={`${id}-expand`}
      plain
      label="⤢"
      dimColor
      onPress={async () => {
        remember(expandedBytes, hash, base64)
        await update($, expanded, () => (key ? { label, hash, key, ...own } : { label, hash, ...own }))
        await $.ui.open({ id: PANE, title: label })
      }}
    />
  )
}

// The rounded dim border with its title bar: bold title, dim folder hint, dim meta on the right
function Frame(ui: Ui, at: FrameAt, ...body: JSX.Element[]) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={frameWidth(at) + 4}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Box flexDirection="row" gap={1} flexShrink={1}>
          <Text bold wrap="truncate-end">{at.title}</Text>
          {at.hint ? <Text dimColor wrap="truncate-start">{at.hint}</Text> : null}
        </Box>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          <Text dimColor wrap="truncate-end">{at.meta}</Text>
          {at.actions ?? null}
        </Box>
      </Box>
      {body}
    </Box>
  )
}

// Pictures packed into rows, each with a small title over it
function Panes($: EngineInterface, ui: Ui, id: string, shots: Shot[], box: Box, minRows: number, perRow: number) {
  const { Box, Text, Image } = ui
  const natives = shots.map(shot => nativeColumns(shot.size.width, cellWidth))
  const rows = pack(shots.map(shot => shot.size.width / shot.size.height), box.columns, box.rows, minRows, perRow, 2, cell, natives)
  const width = Math.max(...rows.map(row => row.reduce((sum, slot) => sum + slot.columns, 0) + 2 * (row.length - 1)))
  const tree = (
    <Box flexDirection="column" gap={1}>
      {rows.map((row, r) => (
        <Box key={`${id}-row-${r}`} flexDirection="row" gap={2}>
          {row.map(slot => {
            const shot = shots[slot.index]!
            const hasMeta = slot.columns >= shot.title.length + shot.meta.length + 3
            return (
              <Box key={`${id}-pane-${slot.index}`} flexDirection="column" width={slot.columns}>
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Text bold wrap="truncate-end">{shot.title}</Text>
                  <Box flexDirection="row" gap={1} flexShrink={0}>
                    {hasMeta ? <Text dimColor>{shot.meta}</Text> : null}
                    {ExpandButton($, ui, `${id}-pane-${slot.index}`, shot.title, shot.base64, shot.key, shot.size)}
                  </Box>
                </Box>
                <Image
                  key={`${id}-img-${slot.index}-${slot.columns}x${slot.rows}-${fingerprint(shot.base64).slice(0, 8)}`}
                  source={{ png: shot.base64 }}
                  columns={slot.columns}
                  rows={slot.rows}
                  alt={`[image: ${shot.title}]`}
                />
              </Box>
            )
          })}
        </Box>
      ))}
    </Box>
  )
  return { tree, width }
}

function shot(title: string, pic: Pic): Shot {
  return { title, meta: pixels(pic.size), ...pic }
}

function picOf(file: PngFile): Pic {
  return { base64: file.base64, size: sizeOf(file) }
}

function diskPic(base64: string): Pic {
  return { base64, size: pngSize(base64) ?? UNKNOWN }
}

async function drawPair($: EngineInterface, ui: Ui, requestId: string, pair: Pair, box: Box) {
  const { Box, Button } = ui
  const shown = await read($, memberOf(mode, { requestId }))
  const sides = [
    ...(shown !== 'after' ? [shot('Before', pair.before)] : []),
    ...(shown !== 'before' ? [shot('After', pair.after)] : []),
  ]
  // Keyed by the drawing's own id: a group can hold this pair twice, from a Read and from the command that made it
  const panes = Panes($, ui, `${requestId}-${pair.stem}`, sides, box, 1, 2)
  const meta = ['before | after', sizeWarning(pair.before.size, pair.after.size)].filter(Boolean).join(' · ')
  const controls = Controls(
    ui,
    MODES.map(one => (
        <Button
          key={`mode-${one.mode}-${pair.stem}`}
          label={one.label}
          variant={one.mode === shown ? 'primary' : undefined}
          dimColor={one.mode !== shown}
          onPress={() => update($, memberOf(mode, { requestId }), () => one.mode)}
        />
      )),
  )
  const at = { title: pair.stem, hint: pair.hint, meta, width: panes.width, controls: buttonsWidth(MODES.map(one => one.label)), max: box.columns }
  return Frame(ui, at, controls, panes.tree)
}

// A lone PNG read: its pair when the before file is on disk, else the picture and its versions
async function drawRead(
  $: EngineInterface,
  ui: Ui,
  requestId: string,
  path: string,
  file: PngFile,
  columns: number | undefined,
  isExpanded?: boolean,
  isUnread?: boolean,
) {
  const { Box, Button, Image, Text } = ui
  const box = room(columns, isExpanded)
  const pair = pairOf(path)
  if (pair?.side === 'after') {
    const before = await readDisk($, pair.before)
    if (before) {
      const both = { stem: pair.stem, hint: hintOf(path), before: diskPic(before), after: picOf(file) }
      return drawPair($, ui, requestId, both, wide(columns))
    }
  }
  const stem = path ? splitPath(path).stem : 'image'
  const own = hashFor(requestId, file.base64)
  const saved = (await kept($))[path]?.versions ?? []
  // A row older than the kept history draws alone rather than posing as the newest version
  const isKept = saved.some(one => one.hash === own)
  const versions = isKept ? saved : [{ hash: own, at: 0, slot: -1 }]
  const ownAt = versions.findIndex(one => one.hash === own)
  const stepped = await read($, memberOf(step, { requestId }))
  let at = stepped >= 0 && stepped < versions.length ? stepped : ownAt
  let base64 = file.base64
  if (at !== ownAt) {
    const older = versions[at]!.slot < 0 ? undefined : await readVersion($, path, versions[at]!.slot, versions[at]!.hash)
    if (older) {
      base64 = older
    } else {
      at = ownAt
    }
  }
  const version = versions[at]!
  const size = at === ownAt ? sizeOf(file) : (pngSize(base64) ?? sizeOf(file))
  const cells = fit(size, box.columns, box.rows, cell, nativeColumns(size.width, cellWidth))
  const hasHistory = versions.length > 1
  const meta = [isUnread ? UNREAD : '', !isKept && saved.length > 0 ? 'older than the kept versions' : '', pixels(size), hasHistory && version.at ? clock(version.at) : '']
    .filter(Boolean)
    .join(' · ')
  const go = (by: number) => () =>
    update($, memberOf(step, { requestId }), n => Math.max(0, Math.min(versions.length - 1, (n >= 0 ? n : ownAt) + by)))
  const image = (
    <Image
      key={`img-${cells.columns}x${cells.rows}-${version.hash.slice(0, 8)}`}
      source={{ png: base64 }}
      columns={cells.columns}
      rows={cells.rows}
      alt={`[image: ${stem}]`}
    />
  )
  const frame: FrameAt = { title: stem, hint: hintOf(path), meta, width: cells.columns, max: box.columns, actions: [ExpandButton($, ui, requestId, stem, base64, path || undefined, size)] }
  if (!hasHistory) {
    return Frame(ui, frame, image)
  }
  const shown = await read($, memberOf(view, { requestId }))
  const chip = (to: ShowReadImageView, label: string) => (
    <Button
      key={`view-${to}`}
      label={label}
      variant={shown === to ? 'primary' : undefined}
      dimColor={shown !== to}
      onPress={() => update($, memberOf(view, { requestId }), () => to)}
    />
  )
  const chips = [chip('now', 'now'), chip('side', 'side by side')]
  if (shown === 'side') {
    const first = Math.max(0, versions.length - MAX_SIDE)
    const shots: Shot[] = []
    for (let i = first; i < versions.length; i++) {
      const one = versions[i]!
      const bytes = i === ownAt ? file.base64 : one.slot < 0 ? undefined : await readVersion($, path, one.slot, one.hash)
      if (bytes) {
        const pic = i === ownAt ? picOf(file) : diskPic(bytes)
        shots.push({ ...shot(i === ownAt ? 'Now' : `v${i + 1}`, pic), key: path })
      }
    }
    const panes = Panes($, ui, `${requestId}-side`, shots, wide(columns), 6, 3)
    const note = first > 0 ? <Text dimColor>{`${first} older version(s) not shown`}</Text> : null
    return Frame(
      ui,
      { title: stem, hint: hintOf(path), meta: `${versions.length} versions`, width: panes.width, controls: buttonsWidth(['now', 'side by side']), max: wide(columns).columns },
      Controls(ui, chips),
      ...(note ? [note] : []),
      panes.tree,
    )
  }
  const position = `v${at + 1}/${versions.length}`
  const note = at === ownAt ? 'as read here' : `older version, read here was v${ownAt + 1}`
  const controls = Controls(
    ui,
    chips,
    [
      <Button key="prev" plain label="◀" dimColor={at === 0} onPress={go(-1)} />,
      <Text key="position">{position}</Text>,
      <Button key="next" plain label="▶" dimColor={at === versions.length - 1} onPress={go(1)} />,
    ],
    [<Text key="note" dimColor>{note}</Text>],
  )
  const width = buttonsWidth(['now', 'side by side']) + 3 + position.length + 4 + 3 + note.length
  return Frame(ui, { ...frame, controls: width }, controls, image)
}

// A group's before/after pairs, an after read pairing with its before on disk, and the rest
async function plan($: EngineInterface, reads: Read[]) {
  const byPath = new Map(reads.map(one => [one.path, one]))
  const pairs: Pair[] = []
  const rest: Read[] = []
  const seen = new Set<string>()
  for (const { path } of reads) {
    if (seen.has(path)) {
      continue
    }
    seen.add(path)
    const one = byPath.get(path)!
    const pair = pairOf(path)
    const other = pair && byPath.get(pair.side === 'before' ? pair.after : pair.before)
    if (pair && other) {
      seen.add(other.path)
      const [before, after] = pair.side === 'before' ? [one, other] : [other, one]
      pairs.push({ stem: pair.stem, hint: hintOf(path), before: picOf(before.file), after: picOf(after.file) })
      continue
    }
    const disk = pair?.side === 'after' ? await readDisk($, pair.before) : undefined
    if (pair && disk) {
      pairs.push({ stem: pair.stem, hint: hintOf(path), before: diskPic(disk), after: picOf(one.file) })
      continue
    }
    rest.push(one)
  }
  return { pairs, rest }
}

// A PNG of the file under the 2 MiB an Image takes: as it is, or converted and scaled down
async function pngOfFile($: EngineInterface, path: string): Promise<string | undefined> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat || stat.kind !== 'file') {
    return undefined
  }
  if (isPngPath(path) && stat.size <= MAX_PNG) {
    return readDisk($, path)
  }
  // One set of conversions per source path, redone when the source is newer
  const out = convertedOf(await homeOf($), path)
  for (const side of [2048, 1400, 1000]) {
    const to = `${out}-${side}.png`
    const made = await $.fs.stat(to).catch(() => undefined)
    if ((!made || made.mtimeMs < stat.mtimeMs) && !(await toPng($, path, to, side))) {
      return undefined
    }
    const size = (await $.fs.stat(to).catch(() => undefined))?.size ?? Infinity
    if (size <= MAX_PNG) {
      return readDisk($, to)
    }
  }
  return undefined
}

function convertedOf(home: string, path: string) {
  return `${home}/.cache/show-read-image/converted/${hashOf(path).slice(0, 12)}`
}

// A block that is not a small PNG goes through a file of its own call, removed with its conversions after
async function pngOfBlock($: EngineInterface, base64: string, id: string): Promise<string | undefined> {
  if (isPng(base64) && base64.length * 0.75 <= MAX_PNG) {
    return base64
  }
  const home = await homeOf($)
  const raw = `${home}/.cache/show-read-image/converted/${id}.raw`
  try {
    return (await writeBytes($, raw, base64)) ? await pngOfFile($, raw) : undefined
  } finally {
    const out = convertedOf(home, raw)
    await $.process.run(['rm', '-f', raw, `${out}-2048.png`, `${out}-1400.png`, `${out}-1000.png`]).catch(() => undefined)
  }
}

// Keeps what a tool call produced as versions under the call's id, so its row can draw them later
async function collect(
  $: EngineInterface,
  id: string,
  tool: string,
  input: Record<string, unknown>,
  result: unknown,
  text: string,
  startedAt: number,
) {
  const short = tool.split('__').pop() ?? tool
  const shots: ShowReadImageCardShot[] = []
  const blocks = imageBlocks(result)
  if (blocks.length > 0) {
    const { tool: _tool, tool_use_id: _id, ...args } = input
    const base = `${short}-${hashOf(JSON.stringify(args).slice(0, 300)).slice(0, 6)}`
    for (const [i, block] of blocks.entries()) {
      const key = blocks.length > 1 ? `${base}-${i + 1}` : base
      const base64 = await pngOfBlock($, block.base64, `${id}-${i}`)
      if (base64) {
        await record($, key, base64)
        shots.push({ key, label: short, hash: hashOf(base64), isUnread: false })
      }
    }
  } else {
    const command = tool === 'Bash' && typeof input.command === 'string' ? input.command : undefined
    for (const path of imagePathsIn(text, command)) {
      // Only what this call wrote: a path it merely printed keeps its older modification time
      const stat = await $.fs.stat(path).catch(() => undefined)
      if (!stat || stat.mtimeMs < startedAt - 1000) {
        continue
      }
      const base64 = await pngOfFile($, path)
      if (base64) {
        await record($, path, base64)
        shots.push({ key: path, label: splitPath(path).stem, hash: hashOf(base64), isUnread: true })
      }
    }
  }
  if (shots.length > 0) {
    await keepCard($, id, { shots, at: startedAt, isCommand: true })
  }
}

async function markSeen($: EngineInterface, path: string, hash: string) {
  const now = await $.clock.now()
  const all = await update($, seen, before => {
    const keys = Object.keys(before)
    const kept = keys.length >= MAX_SEEN ? Object.fromEntries(keys.slice(-MAX_SEEN / 2).map(k => [k, before[k]!])) : before
    return { ...kept, [`${path}#${hash}`]: now }
  })
  await $.store.set('seen', all)
}

async function keepCard($: EngineInterface, id: string, card: ShowReadImageCard) {
  const all = await update($, cards, before => {
    const ids = Object.keys(before)
    const kept = ids.length >= MAX_CARDS_KEPT ? Object.fromEntries(ids.slice(-MAX_CARDS_KEPT / 2).map(k => [k, before[k]!])) : before
    return { ...kept, [id]: card }
  })
  await $.store.set('cards', all)
}

type ShowInput = { images: { path: string; label?: string; version?: number }[]; title?: string }

// The show_images tool: each path as it is now, or `version` steps back through what was kept of it
async function show($: EngineInterface, id: string, input: ShowInput): Promise<string> {
  const shots: ShowReadImageCardShot[] = []
  const missing: string[] = []
  const notes: string[] = []
  for (const image of input.images.slice(0, MAX_SIDE)) {
    const base64 = await pngOfFile($, image.path)
    if (!base64) {
      missing.push(image.path)
      continue
    }
    await record($, image.path, base64)
    const versions = (await kept($))[image.path]?.versions ?? []
    const now = versions.findIndex(one => one.hash === hashOf(base64))
    const wanted = now + Math.min(0, Math.trunc(image.version ?? 0))
    const at = Math.max(0, wanted)
    if (wanted < 0) {
      notes.push(`${image.path} has only ${now} older version(s) kept; showing the oldest`)
    }
    if (now < versions.length - 1) {
      notes.push(`${image.path} now matches kept version ${now + 1} of ${versions.length}; versions step back from there`)
    }
    shots.push({ key: image.path, label: image.label ?? splitPath(image.path).stem, hash: versions[at]?.hash ?? hashOf(base64), isUnread: true })
  }
  if (shots.length > 0) {
    await keepCard($, id, input.title === undefined ? { shots } : { title: input.title, shots })
  }
  const shown = `Shown ${shots.length} image(s) to the user, marked as not read by you.`
  return [shown, ...notes.map(note => `Note: ${note}.`), ...(missing.length > 0 ? [`Could not show: ${missing.join(', ')}`] : [])].join(' ')
}

// A Read that came back as JPEG or another type: converted to PNG and drawn as a card, since an Image takes PNG bytes
async function readAsCard($: EngineInterface, id: string, path: string, image: PngFile) {
  // The file itself converts best; Read's copy is the fallback when the file is gone or unreadable
  const png = (await pngOfFile($, path)) ?? (await pngOfBlock($, image.base64, id))
  if (!png) {
    return
  }
  await record($, path, png)
  const width = image.dimensions?.originalWidth
  const height = image.dimensions?.originalHeight
  const own = width && height ? { width, height } : {}
  await keepCard($, id, { shots: [{ key: path, label: splitPath(path).stem, hash: hashOf(png), isUnread: false, ...own }] })
}

// By content, so a card still draws after its version has left the path's history
async function bytesOf($: EngineInterface, shot: ShowReadImageCardShot) {
  const version = (await kept($))[shot.key]?.versions.find(one => one.hash === shot.hash)
  return readVersion($, shot.key, version?.slot ?? -1, shot.hash)
}

// One picture draws as a read does, with its versions; several share a frame
async function drawCard($: EngineInterface, ui: Ui, id: string, card: ShowReadImageCard, columns: number | undefined) {
  if (card.isCommand) {
    const shown = await read($, seen)
    const later = (shot: ShowReadImageCardShot) => (shown[`${shot.key}#${shot.hash}`] ?? -Infinity) >= (card.at ?? Infinity)
    // A later Read already shows it, so this card adds nothing
    if (card.shots.length > 0 && card.shots.every(later)) {
      return undefined
    }
  }
  const pictures: { shot: ShowReadImageCardShot; base64: string }[] = []
  for (const shot of card.shots) {
    const base64 = await bytesOf($, shot)
    if (base64) {
      pictures.push({ shot, base64 })
    }
  }
  const [only] = pictures
  if (!only) {
    return undefined
  }
  if (pictures.length === 1 && card.title === undefined) {
    const dimensions = only.shot.width && only.shot.height ? { originalWidth: only.shot.width, originalHeight: only.shot.height } : undefined
    return drawRead($, ui, id, only.shot.key, dimensions ? { base64: only.base64, dimensions } : { base64: only.base64 }, columns, false, only.shot.isUnread)
  }
  const { Box, Button } = ui
  const chosen = await read($, memberOf(pick, { requestId: id }))
  const at = chosen >= 0 && chosen < pictures.length ? chosen : -1
  const choose = (to: number) => () => update($, memberOf(pick, { requestId: id }), () => to)
  const chip = (to: number, label: string) => (
    <Button key={`pick-${to}`} label={label} variant={at === to ? 'primary' : undefined} dimColor={at !== to} onPress={choose(to)} />
  )
  const isPair = pictures.length === 2
  const chips =
    pictures.length < 2
      ? []
      : [
          chip(-1, isPair ? 'side by side' : 'all'),
          ...pictures.map((one, i) => (isPair ? chip(i, `${one.shot.label} only`) : i === 0 ? null : chip(i, `vs ${one.shot.label}`))),
        ].filter(one => one !== null)
  const shown = at < 0 ? pictures : isPair ? [pictures[at]!] : [pictures[0]!, pictures[at]!]
  const panes = Panes($, ui, `${id}-card`, shown.map(one => shot(one.shot.label, diskPic(one.base64))), wide(columns), 6, isPair || at >= 0 ? 2 : 3)
  const meta = [pictures.some(one => one.shot.isUnread) ? UNREAD : '', pictures.length > 1 ? `${pictures.length} images` : pixels(diskPic(only.base64).size)]
    .filter(Boolean)
    .join(' · ')
  const labels = pictures.length < 2 ? [] : isPair ? ['side by side', ...pictures.map(one => `${one.shot.label} only`)] : ['all', ...pictures.slice(1).map(one => `vs ${one.shot.label}`)]
  const controls = chips.length > 0 ? [Controls(ui, chips)] : []
  const frame: FrameAt = { title: card.title ?? only.shot.label, meta, width: panes.width, controls: buttonsWidth(labels), max: wide(columns).columns }
  return Frame(ui, frame, ...controls, panes.tree)
}

async function cardsIn($: EngineInterface, calls: ReadonlyArray<ToolGroupCall>) {
  const all = await read($, cards)
  return calls.flatMap(call => {
    const card = call.tool_use_id ? all[call.tool_use_id] : undefined
    return call.tool_use_id && card ? [[call.tool_use_id, card] as const] : []
  })
}

function readsOf(calls: ReadonlyArray<ToolGroupCall>): Read[] {
  return calls.flatMap((call, i) => {
    const file = pngOf(call.tool, call.output)
    return file && !call.isErrored ? [{ id: call.tool_use_id ?? `call-${i}`, path: pathOf(call.input), file }] : []
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('history')
    if (stored && typeof stored === 'object') {
      await update($, history, all => (Object.keys(all).length > 0 ? all : (stored as Record<string, ShowReadImageHistory>)))
    }
    const storedSeen = await $.store.get('seen')
    if (storedSeen && typeof storedSeen === 'object') {
      await update($, seen, all => (Object.keys(all).length > 0 ? all : (storedSeen as Record<string, number>)))
    }
    const storedCards = await $.store.get('cards')
    if (storedCards && typeof storedCards === 'object') {
      await update($, cards, all => (Object.keys(all).length > 0 ? all : (storedCards as Record<string, ShowReadImageCard>)))
    }
    await $.tool.register({
      name: 'show_images',
      description:
        'Show image files to the user under this call, without loading them into your context. The card says the images were not read by you, ' +
        'so Read an image instead when you need to see it yourself or make claims about it. One image draws on its own; several share one frame, ' +
        'side by side, in the order given. Each item: path, optional label, optional version (0 = the file as it is now; -1 = the version kept ' +
        'before it, -2 the one before that).',
      isDeferred: true,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          images: {
            type: 'array',
            minItems: 1,
            maxItems: 6,
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, label: { type: 'string' }, version: { type: 'integer', maximum: 0 } },
              required: ['path'],
            },
          },
        },
        required: ['images'],
      },
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__show-read-image__show_images' }, async ($, e) => {
    const input = e as unknown as ShowInput
    return { result: await show($, e.tool_use_id, input) }
  }).catch(() => ({ deny: 'show-read-image: could not show the images.' }))

  // Keeps each new content of a PNG path as a version so older ones can be drawn again
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    const file = ran.deny === undefined && !ran.isError ? pngOf('Read', ran.result) : undefined
    if (file && e.file_path) {
      paths.set(e.tool_use_id, e.file_path)
      await record($, e.file_path, file.base64).catch(() => undefined)
      await markSeen($, e.file_path, hashOf(file.base64)).catch(() => undefined)
    }
    const other = ran.deny === undefined && !ran.isError ? otherImageOf('Read', ran.result) : undefined
    if (other && e.file_path) {
      const note = `${e.file_path}: Read returned ${other.type}, ${other.base64.length} base64 chars`
      $.ui.log(`show-read-image: ${note}`, { to: 'debug' })
      void homeOf($).then(home => $.fs.write(`${home}/.cache/show-read-image/last-read.txt`, `${note}\n`)).catch(() => undefined)
      void readAsCard($, e.tool_use_id, e.file_path, other).catch(() => undefined)
    }
    return ran
  }).catch(($, e, next) => (next.called ? { deny: 'show-read-image: the tool call failed under its hook.' } : next(e)))

  // Images any other tool produced: inline blocks, or image files it printed
  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const ran = await next(e)
    try {
      const tool = String(e.tool)
      if (!SKIP_TOOLS.test(tool) && ran.deny === undefined && ran.isError !== true) {
        const input = e as unknown as Record<string, unknown>
        void collect($, e.tool_use_id, tool, input, ran.result, ran.text ?? '', startedAt).catch(() => undefined)
      }
    } catch {
      // The tool already ran; its result stands whatever happens to the card
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Expand: the picture as large as the pane allows, enlarged if need be, which is the point of opening it
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }
    const ui = $.ui.resolve(e)
    const { Box, Button, Image, Text } = ui
    const shown = await read($, expanded)
    const versions = shown?.key ? ((await kept($))[shown.key]?.versions ?? []) : []
    const base64 = shown
      ? (expandedBytes.get(shown.hash) ?? (shown.key ? await readVersion($, shown.key, -1, shown.hash) : undefined))
      : undefined
    if (!shown || !base64) {
      return <Text dimColor>Nothing to show: press ⤢ on a picture.</Text>
    }
    const size = pngSize(base64) ?? UNKNOWN
    const cells = fit(size, e.props.bodyColumns, Math.max(4, e.props.scroll.bodyRows - 2), cell)
    const at = versions.findIndex(one => one.hash === shown.hash)
    const step = (by: number) => async () => {
      const to = versions[at + by]
      const bytes = to && shown.key ? await readVersion($, shown.key, to.slot, to.hash) : undefined
      if (to && bytes) {
        remember(expandedBytes, to.hash, bytes)
        // Another version has its own size, read from its bytes
        const { width: _width, height: _height, ...rest } = shown
        await update($, expanded, () => ({ ...rest, hash: to.hash }))
      }
    }
    const stepper =
      at >= 0 && versions.length > 1
        ? [
            <Button key="pane-prev" plain label="◀" dimColor={at === 0} onPress={step(-1)} />,
            <Text key="pane-at">{`v${at + 1}/${versions.length}`}</Text>,
            <Button key="pane-next" plain label="▶" dimColor={at === versions.length - 1} onPress={step(1)} />,
          ]
        : []
    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Image key={`pane-${shown.hash.slice(0, 8)}-${cells.columns}x${cells.rows}`} source={{ png: base64 }} columns={cells.columns} rows={cells.rows} alt={`[image: ${shown.label}]`} />
        {Controls(
          ui,
          [<Text key="pane-label" bold>{shown.label}</Text>, <Text key="pane-size" dimColor>{pixels(shown.width && shown.height ? { width: shown.width, height: shown.height } : size)}</Text>],
          ...(stepper.length > 0 ? [stepper] : []),
          [<Button key="pane-close" label="close" dimColor onPress={() => $.ui.close({ id: PANE })} />],
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const reads = readsOf(e.props.calls)
    for (const one of reads) {
      mates.set(one.id, reads.map(other => other.path))
    }
    if (e.props.isExpanded || e.surface !== 'terminal') {
      return next(e)
    }
    const toolCards = await cardsIn($, e.props.calls)
    if (reads.length === 0) {
      if (toolCards.length === 0) {
        return next(e)
      }
      void measure($, e.viewport)
      const ui = $.ui.resolve(e)
      const line = await next(e)
      const drawn = []
      for (const [id, card] of toolCards) {
        drawn.push(await drawCard($, ui, id, card, e.viewport?.columns))
      }
      return (
        <ui.Box flexDirection="column">
          {line}
          {drawn.filter(tree => tree !== undefined)}
        </ui.Box>
      )
    }
    const attempts = e.props.calls.filter(call => call.tool === 'Read' && isPngPath(pathOf(call.input)))
    if (attempts.some(call => call.isRunning)) {
      return next(e)
    }
    const isGallery = reads.length >= 2 && attempts.every(call => !call.isErrored && !call.isInterrupted && pngOf(call.tool, call.output))
    if (!isGallery) {
      return next({ ...e, props: { ...e.props, isExpanded: true } })
    }
    void measure($, e.viewport)
    const ui = $.ui.resolve(e)
    const columns = e.viewport?.columns
    const line = await next(e)
    const { pairs, rest } = await plan($, reads)
    const trees: JSX.Element[] = []
    for (const pair of pairs) {
      trees.push(await drawPair($, ui, `${e.requestId}:${pair.stem}`, pair, wide(columns)))
    }
    if (rest.length === 1) {
      trees.push(await drawRead($, ui, rest[0]!.id, rest[0]!.path, rest[0]!.file, columns))
    } else if (rest.length > 1) {
      const shots = rest.map(one => shot(splitPath(one.path).stem, picOf(one.file)))
      const panes = Panes($, ui, 'gallery', shots, wide(columns), 6, 2)
      const hints = [...new Set(rest.map(one => hintOf(one.path)))]
      const at = { title: `${shots.length} images`, hint: hints.length === 1 ? hints[0] : undefined, meta: `${rest.length} reads` }
      trees.push(Frame(ui, { ...at, width: panes.width, max: wide(columns).columns }, panes.tree))
    }
    // A command that made the files the group then read adds nothing the reads don't already show
    const readPaths = new Set(reads.flatMap(one => [one.path, pairOf(one.path)?.before ?? '', pairOf(one.path)?.after ?? '']))
    for (const [id, card] of toolCards) {
      if (card.shots.every(one => readPaths.has(one.key))) {
        continue
      }
      const tree = await drawCard($, ui, id, card, columns)
      if (tree) {
        trees.push(tree)
      }
    }
    return (
      <ui.Box flexDirection="column">
        {line}
        {trees}
      </ui.Box>
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const file = pngOf(e.props.tool, e.props.output)
    if (e.surface !== 'terminal' || e.props.isErrored) {
      return next(e)
    }
    if (!file) {
      const id = e.props.tool_use_id ?? e.requestId
      const card = (await read($, cards))[id]
      if (!card) {
        return next(e)
      }
      void measure($, e.viewport)
      const row = await next(e)
      const ui = $.ui.resolve(e)
      const tree = await drawCard($, ui, id, card, e.viewport?.columns)
      return (
        <ui.Box flexDirection="column">
          {row}
          {tree ?? null}
        </ui.Box>
      )
    }
    const path = pathOf(e.props.input)
    paths.set(e.requestId, path)
    const pair = pairOf(path)
    // The pair draws under the after row when both were read in one group
    if (pair?.side === 'before' && mates.get(e.requestId)?.includes(pair.after)) {
      return next(e)
    }
    void measure($, e.viewport)
    const row = await next(e)
    const ui = $.ui.resolve(e)
    const tree = await drawRead($, ui, e.requestId, path, file, e.viewport?.columns)
    return (
      <ui.Box flexDirection="column">
        {row}
        {tree}
      </ui.Box>
    )
  })

  // ctrl+o draws a standalone result at full width
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const file = pngOf(e.props.tool, e.props.output)
    if (!file || e.props.isErrored || e.surface !== 'terminal') {
      return next(e)
    }
    void measure($, e.viewport)
    const ui = $.ui.resolve(e)
    const path = paths.get(e.requestId) ?? ''
    return drawRead($, ui, e.requestId, path, file, e.viewport?.columns, e.props.isExpanded)
  })
}
