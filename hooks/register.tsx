import { atom, memberOf, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, ToolGroupCall, UiPressArgument } from 'claude-code'

import type { ShowReadImageCard, ShowReadImageCardShot, ShowReadImageChapter, ShowReadImageExpanded, ShowReadImageHistory, ShowReadImageMode, ShowReadImageView } from '../types'
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
  isVideoPath,
  nativeColumns,
  pack,
  pairOf,
  otherImageOf,
  pathOf,
  pixels,
  playerBox,
  pngOf,
  pngSize,
  sizeOf,
  sizeWarning,
  clockOf,
  playWord,
  samplesRow,
  scrubChunks,
  splitPath,
  videoNote,
} from './logic'
import type { PngFile } from './logic'
import { converter, filmstrip, openExternally, playbackSource, toPng, writeBytes } from './platform'
import { PLAYER_FPS, current as currentPlayback, playerKey, pause as pausePlayback, play, stop as stopPlayback } from './player'

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
  { mode: 'both', label: 'Both' },
  { mode: 'before', label: 'Before' },
  { mode: 'after', label: 'After' },
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

// What a card's frame says: the title line, the body's width, and the footer under it
type Footer = { left: JSX.Element[]; right: JSX.Element[]; width: number }
type FrameAt = { title: string; hint?: string; meta: string; width: number; max: number; isUnread?: boolean; footer?: Footer }

const UNREAD_MARK = '◌ not read'

// Labels set three columns apart, as a footer draws them
function labelsWidth(labels: string[]) {
  return labels.reduce((sum, label) => sum + label.length, 0) + 3 * Math.max(0, labels.length - 1)
}

// As wide as its widest line, picture, title line or footer, so none of them is crushed; pictures keep their own size
function frameWidth(at: FrameAt) {
  const header = at.title.length + (at.hint ? at.hint.length + 1 : 0) + (at.isUnread ? UNREAD_MARK.length + 2 : 0) + 2 + at.meta.length
  return Math.min(at.max, Math.max(MIN_FRAME, at.width, header, at.footer?.width ?? 0))
}

// A quiet action: dim until pointed at, no brackets
function Link(ui: Ui, key: string, label: string, onPress: (press: UiPressArgument) => unknown) {
  return <ui.Button key={key} plain dimColor label={label} onPress={press => void onPress(press)} />
}

// One of a few views: the one showing is bold text, the others are links to it
function Choice(ui: Ui, key: string, label: string, isActive: boolean, onPress: () => unknown) {
  return isActive ? <ui.Text key={key} bold>{label}</ui.Text> : Link(ui, key, label, onPress)
}

// The footer's actions for one picture: Expand and View at full strength, then Save to Downloads and Copy path
// where it has a file
function pictureActions($: EngineInterface, ui: Ui, id: string, label: string, base64: string, path?: string, size?: Size, video?: string, duration?: number) {
  const file = video ?? path
  const fileActions = file
    ? [
        <ui.Button key={`${id}-open`} plain label="↗ View" onPress={() => void openExternally($, file)} />,
        Link(ui, `${id}-save`, 'Save to Downloads', () => saveToDownloads($, file)),
        Link(ui, `${id}-copy`, 'Copy path', async press => {
          const copied = await $.ui.copy({ text: file, surface: press.surface })
          await $.ui.toast(copied.isCopied ? 'Path copied' : 'Could not copy the path')
        }),
      ]
    : []
  const elements = [ExpandLink($, ui, id, label, base64, path, size, video, '⤢ Expand', false, duration), ...fileActions]
  const labels = ['⤢ Expand', ...(file ? ['↗ View', 'Save to Downloads', 'Copy path'] : [])]
  return { elements, width: labelsWidth(labels) }
}

// A copy in ~/Downloads, numbered rather than overwriting one already there
async function saveToDownloads($: EngineInterface, file: string) {
  const folder = `${await homeOf($)}/Downloads`
  const name = splitPath(file).name
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  let out = `${folder}/${name}`
  for (let n = 2; await $.fs.exists(out); n++) {
    out = `${folder}/${stem} ${n}${ext}`
  }
  await $.process.run(['mkdir', '-p', folder]).catch(() => undefined)
  const copied = await $.process.run(['cp', file, out]).catch(() => undefined)
  await $.ui.toast(copied?.exitCode === 0 ? `Saved to Downloads/${splitPath(out).name}` : 'Could not save it to Downloads')
}

// Opens the Expand pane on this picture; `key` lets it step through the picture's versions
function ExpandLink($: EngineInterface, ui: Ui, id: string, label: string, base64: string, key?: string, size?: Size, video?: string, text = '⤢ Expand', isDim = true, duration?: number) {
  const hash = hashOf(base64)
  const own = { ...(size ? { width: size.width, height: size.height } : {}), ...(video ? { video } : {}), ...(duration ? { duration } : {}) }
  const open = async () => {
    remember(expandedBytes, hash, base64)
    await update($, expanded, () => (key ? { label, hash, key, ...own } : { label, hash, ...own }))
    await $.ui.open({ id: PANE, title: label })
  }
  return isDim ? Link(ui, `${id}-expand`, text, open) : <ui.Button key={`${id}-expand`} plain label={text} onPress={() => void open()} />
}

// A row with views or status on the left and actions on the right, each side kept whole
function Bar(ui: Ui, left: JSX.Element[], right: JSX.Element[], marginTop = 0) {
  const { Box } = ui
  return (
    <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={3} marginTop={marginTop}>
      <Box flexDirection="row" columnGap={3} flexShrink={0}>{left}</Box>
      <Box flexDirection="row" columnGap={3} flexShrink={0}>{right}</Box>
    </Box>
  )
}

// The rounded dim border: the title line, the body, and a footer with views on the left and actions on the right
function Frame(ui: Ui, at: FrameAt, ...body: JSX.Element[]) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={frameWidth(at) + 4}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Box flexDirection="row" gap={1} flexShrink={1}>
          <Text bold wrap="truncate-end">{at.title}</Text>
          {at.hint ? <Text dimColor wrap="truncate-start">{at.hint}</Text> : null}
          {at.isUnread ? <Text dimColor italic>{`  ${UNREAD_MARK}`}</Text> : null}
        </Box>
        <Text dimColor wrap="truncate-end">{at.meta}</Text>
      </Box>
      {body}
      {at.footer ? Bar(ui, at.footer.left, at.footer.right, 1) : null}
    </Box>
  )
}

// Pictures packed into rows, each captioned underneath with its label and size, and its own ⤢
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
            const hasMeta = slot.columns >= shot.title.length + shot.meta.length + 6
            return (
              <Box key={`${id}-pane-${slot.index}`} flexDirection="column" width={slot.columns}>
                <Image
                  key={`${id}-img-${slot.index}-${slot.columns}x${slot.rows}-${fingerprint(shot.base64).slice(0, 8)}`}
                  source={{ png: shot.base64 }}
                  columns={slot.columns}
                  rows={slot.rows}
                  alt={`[image: ${shot.title}]`}
                />
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Box flexDirection="row" gap={1} flexShrink={1}>
                    <Text wrap="truncate-end">{shot.title}</Text>
                    {hasMeta ? <Text dimColor>{`· ${shot.meta}`}</Text> : null}
                  </Box>
                  {ExpandLink($, ui, `${id}-pane-${slot.index}`, shot.title, shot.base64, shot.key, shot.size, undefined, '⤢')}
                </Box>
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
  const shown = await read($, memberOf(mode, { requestId }))
  const sides = [
    ...(shown !== 'after' ? [shot('Before', pair.before)] : []),
    ...(shown !== 'before' ? [shot('After', pair.after)] : []),
  ]
  // Keyed by the drawing's own id: a group can hold this pair twice, from a Read and from the command that made it
  const panes = Panes($, ui, `${requestId}-${pair.stem}`, sides, box, 1, 2)
  const meta = sizeWarning(pair.before.size, pair.after.size) || 'before and after'
  const choices = MODES.map(one =>
    Choice(ui, `mode-${one.mode}-${pair.stem}`, one.label, one.mode === shown, () => update($, memberOf(mode, { requestId }), () => one.mode)),
  )
  const footer = { left: choices, right: [], width: labelsWidth(MODES.map(one => one.label)) }
  return Frame(ui, { title: pair.stem, hint: pair.hint, meta, width: panes.width, max: box.columns, footer }, panes.tree)
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
  video?: VideoAt,
) {
  const { Image, Text } = ui
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
  if (video?.site) {
    return drawVideo($, ui, requestId, video, file, stem, hintOf(path), isUnread === true, columns)
  }
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
  const meta = [
    !isKept && saved.length > 0 ? 'older than the kept versions' : '',
    at !== ownAt ? `earlier version, this row read v${ownAt + 1}` : '',
    video?.note ?? pixels(size),
    hasHistory && version.at ? clock(version.at) : '',
  ]
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
  const actions = pictureActions($, ui, requestId, stem, base64, path || undefined, size, video?.path)
  // Frames the video tool didn't stamp with their time get the times in a row under the grid
  const samples = video?.samples ? [<Text key={`${requestId}-samples`} dimColor>{video.samples}</Text>] : []
  const frame: FrameAt = { title: stem, hint: hintOf(path), meta, width: cells.columns, max: box.columns, isUnread: isUnread === true }
  if (!hasHistory) {
    return Frame(ui, { ...frame, footer: { left: [], right: actions.elements, width: actions.width } }, image, ...samples)
  }
  const shown = await read($, memberOf(view, { requestId }))
  const setView = (to: ShowReadImageView) => () => update($, memberOf(view, { requestId }), () => to)
  const views = [Choice(ui, 'view-now', 'One', shown !== 'side', setView('now')), Choice(ui, 'view-side', 'All versions', shown === 'side', setView('side'))]
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
    const footer = { left: views, right: [], width: labelsWidth(['One', 'All versions']) }
    return Frame(
      ui,
      { ...frame, meta: `${versions.length} versions`, width: panes.width, max: wide(columns).columns, footer },
      ...(note ? [note] : []),
      panes.tree,
    )
  }
  const position = `${at + 1} of ${versions.length}`
  const stepper = (
    <ui.Box key="stepper" flexDirection="row" gap={1}>
      <ui.Button key="prev" plain label="◀" dimColor={at === 0} onPress={go(-1)} />
      <Text>{position}</Text>
      <ui.Button key="next" plain label="▶" dimColor={at === versions.length - 1} onPress={go(1)} />
    </ui.Box>
  )
  const footer = { left: [stepper, ...views], right: actions.elements, width: position.length + 4 + 3 + labelsWidth(['One', 'All versions']) + 3 + actions.width }
  return Frame(ui, { ...frame, footer }, image, ...samples)
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
type Converted = { base64: string } | { reason: string }

function megabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// A PNG of the file under the 2 MiB an Image takes, or why there is none, for a card to say so
async function convertFile($: EngineInterface, path: string): Promise<Converted> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat || stat.kind !== 'file') {
    return { reason: 'not found' }
  }
  if (isPngPath(path) && stat.size <= MAX_PNG) {
    const base64 = await readDisk($, path)
    return base64 ? { base64 } : { reason: 'unreadable' }
  }
  if (!(await converter($))) {
    return { reason: `${megabytes(stat.size)}, too large to draw without sips, magick, convert or ffmpeg` }
  }
  // One set of conversions per source path, redone when the source is newer
  const out = convertedOf(await convertedDir($), path)
  for (const side of SIDES) {
    const to = `${out}-${side}.png`
    const made = await $.fs.stat(to).catch(() => undefined)
    if ((!made || made.mtimeMs < stat.mtimeMs) && !(await toPng($, path, to, side))) {
      return { reason: `${megabytes(stat.size)}, the converter failed on it` }
    }
    void pruneConverted($)
    const size = (await $.fs.stat(to).catch(() => undefined))?.size ?? Infinity
    if (size <= MAX_PNG) {
      const base64 = await readDisk($, to)
      return base64 ? { base64 } : { reason: 'unreadable after converting' }
    }
  }
  return { reason: `${megabytes(stat.size)}, still over 2 MiB at ${SIDES.at(-1)} px` }
}

async function pngOfFile($: EngineInterface, path: string): Promise<string | undefined> {
  const converted = await convertFile($, path)
  return 'base64' in converted ? converted.base64 : undefined
}

// The converted folder keeps the newest files up to these limits; conversions are remade when needed
const CACHE_BYTES = 200 * 1024 * 1024
const CACHE_FILES = 500
let prunedAt = 0

async function pruneConverted($: EngineInterface) {
  const now = await $.clock.now()
  if (now - prunedAt < 60_000) {
    return
  }
  prunedAt = now
  const dir = await convertedDir($)
  const files = (await $.fs.list(dir).catch(() => []))
    .filter(entry => entry.kind === 'file')
    .map(entry => ({ path: `${dir}/${entry.name}`, size: entry.size, at: entry.mtimeMs }))
    .sort((a, b) => b.at - a.at)
  let total = 0
  const gone = files.filter((file, i) => {
    total += file.size
    return total > CACHE_BYTES || i >= CACHE_FILES
  })
  if (gone.length > 0) {
    await $.process.run(['rm', '-f', ...gone.map(file => file.path)]).catch(() => undefined)
  }
}

// Longest sides to try, largest first, until a conversion fits in 2 MiB; noise and photos need the small ones
const SIDES = [2048, 1400, 1000, 700, 500]

let madeDir: string | undefined

// The converters write files but don't make folders, unlike $.fs.write
async function convertedDir($: EngineInterface) {
  const dir = `${await homeOf($)}/.cache/show-read-image/converted`
  if (madeDir !== dir) {
    await $.process.run(['mkdir', '-p', dir])
    madeDir = dir
  }
  return dir
}

function convertedOf(dir: string, path: string) {
  return `${dir}/${hashOf(path).slice(0, 12)}`
}

// A block that is not a small PNG goes through a file of its own call, removed with its conversions after
async function pngOfBlock($: EngineInterface, base64: string, id: string): Promise<string | undefined> {
  if (isPng(base64) && base64.length * 0.75 <= MAX_PNG) {
    return base64
  }
  const dir = await convertedDir($)
  const raw = `${dir}/${id}.raw`
  try {
    return (await writeBytes($, raw, base64)) ? await pngOfFile($, raw) : undefined
  } finally {
    const out = convertedOf(dir, raw)
    await $.process.run(['rm', '-f', raw, ...SIDES.map(side => `${out}-${side}.png`)]).catch(() => undefined)
  }
}

type Picture = { base64: string; note?: string; samples?: string; duration?: number; isVideo?: true }

const stripNotes = new Map<string, { note: string; samples?: string; duration: number }>()

// A video as a grid of eight timed frames, remade when the video is newer; its timing note is kept per version
async function stripOf($: EngineInterface, video: string): Promise<Picture | undefined> {
  const stat = await $.fs.stat(video).catch(() => undefined)
  if (!stat || stat.kind !== 'file') {
    return undefined
  }
  const dir = await convertedDir($)
  const out = `${convertedOf(dir, video)}-strip.png`
  const key = `${video}:${stat.mtimeMs}`
  if (!stripNotes.has(key)) {
    const stats = await filmstrip($, video, out, dir)
    if (!stats) {
      return undefined
    }
    const note = { note: videoNote(stats), duration: stats.duration }
    remember(stripNotes, key, stats.samples ? { ...note, samples: samplesRow(stats.samples) } : note)
  }
  const base64 = await pngOfFile($, out)
  return base64 ? { base64, ...stripNotes.get(key)!, isVideo: true } : undefined
}

// What a path draws as: a picture, or for a video its filmstrip; else why it can't be drawn
async function pictureOf($: EngineInterface, path: string): Promise<Picture | { reason: string }> {
  if (isVideoPath(path)) {
    return (await stripOf($, path)) ?? { reason: 'no filmstrip: needs swiftc on macOS, or ffmpeg and ffprobe' }
  }
  return convertFile($, path)
}

const failure = (path: string, reason: string) => `${splitPath(path).name}: ${reason}`

function shotOf(path: string, picture: Picture, label = splitPath(path).stem): ShowReadImageCardShot {
  const video = picture.isVideo
    ? {
        note: picture.note ?? '',
        ...(picture.samples ? { samples: picture.samples } : {}),
        ...(picture.duration ? { duration: picture.duration } : {}),
        isVideo: true,
      }
    : {}
  return { key: path, label, hash: hashOf(picture.base64), isUnread: true, ...video }
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
  const failed: string[] = []
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
      const picture = await pictureOf($, path)
      if ('reason' in picture) {
        failed.push(failure(path, picture.reason))
      } else {
        await record($, path, picture.base64)
        shots.push(shotOf(path, picture))
      }
    }
  }
  if (shots.length > 0 || failed.length > 0) {
    await keepCard($, id, { shots, at: startedAt, isCommand: true, ...(failed.length > 0 ? { failed } : {}) })
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

type ShowInput = { images: { path: string; label?: string; version?: number; chapters?: ShowReadImageChapter[] }[]; title?: string }

// The show_images tool: each path as it is now, or `version` steps back through what was kept of it
async function show($: EngineInterface, id: string, input: ShowInput): Promise<string> {
  const shots: ShowReadImageCardShot[] = []
  const missing: string[] = []
  const failed: string[] = []
  const notes: string[] = []
  for (const image of input.images.slice(0, MAX_SIDE)) {
    const picture = await pictureOf($, image.path)
    if ('reason' in picture) {
      missing.push(`${image.path} (${picture.reason})`)
      failed.push(failure(image.path, picture.reason))
      continue
    }
    const base64 = picture.base64
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
    const chapters = picture.isVideo && image.chapters ? chaptersOf(image.chapters, picture.duration) : []
    shots.push({ ...shotOf(image.path, picture, image.label), hash: versions[at]?.hash ?? hashOf(base64), ...(chapters.length > 0 ? { chapters } : {}) })
  }
  if (shots.length > 0 || failed.length > 0) {
    const card: ShowReadImageCard = { shots, ...(input.title === undefined ? {} : { title: input.title }), ...(failed.length > 0 ? { failed } : {}) }
    await keepCard($, id, card)
  }
  const shown = `Shown ${shots.length} image(s) to the user, marked as not read by you.`
  return [shown, ...notes.map(note => `Note: ${note}.`), ...(missing.length > 0 ? [`Could not show: ${missing.join(', ')}`] : [])].join(' ')
}

// Chapters as given, in order, within the clip, and few enough to list beside it
function chaptersOf(chapters: ShowReadImageChapter[], duration = Infinity) {
  return chapters
    .filter(one => typeof one?.label === 'string' && Number.isFinite(one.at) && one.at >= 0 && one.at <= duration)
    .map(one => ({ label: one.label.slice(0, 48), at: one.at }))
    .sort((a, b) => a.at - b.at)
    .slice(0, 12)
}

// A Read that came back as JPEG or another type: converted to PNG and drawn as a card, since an Image takes PNG bytes
async function readAsCard($: EngineInterface, id: string, path: string, image: PngFile) {
  // The file itself converts best; Read's copy is the fallback when the file is gone or unreadable
  const converted = await convertFile($, path)
  const png = 'base64' in converted ? converted.base64 : await pngOfBlock($, image.base64, id)
  if (!png) {
    await keepCard($, id, { shots: [], failed: [failure(path, 'reason' in converted ? converted.reason : 'could not be converted')] })
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
// A card's pictures, with a dim line under them for each one that couldn't be drawn
async function drawCard($: EngineInterface, ui: Ui, id: string, card: ShowReadImageCard, columns: number | undefined, site = id) {
  const drawn = await drawPictures($, ui, id, card, columns, site)
  const failures = (card.failed ?? []).map((line, i) => <ui.Text key={`${id}-failed-${i}`} dimColor>{`  ⚠ ${line}`}</ui.Text>)
  if (failures.length === 0) {
    return drawn
  }
  return (
    <ui.Box flexDirection="column">
      {drawn ?? null}
      {failures}
    </ui.Box>
  )
}

async function drawPictures($: EngineInterface, ui: Ui, id: string, card: ShowReadImageCard, columns: number | undefined, site: string) {
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
  // A lone video always gets its player; a lone picture is drawn as a read is unless the card has a title
  if (pictures.length === 1 && (card.title === undefined || only.shot.isVideo)) {
    const dimensions = only.shot.width && only.shot.height ? { originalWidth: only.shot.width, originalHeight: only.shot.height } : undefined
    const video = only.shot.isVideo
      ? {
          note: only.shot.note ?? 'video',
          path: only.shot.key,
          site,
          ...(only.shot.samples ? { samples: only.shot.samples } : {}),
          ...(only.shot.duration ? { duration: only.shot.duration } : {}),
          ...(only.shot.chapters ? { chapters: only.shot.chapters } : {}),
          ...(card.title ? { title: card.title } : {}),
        }
      : undefined
    return drawRead($, ui, id, only.shot.key, dimensions ? { base64: only.base64, dimensions } : { base64: only.base64 }, columns, false, only.shot.isUnread, video)
  }
  const chosen = await read($, memberOf(pick, { requestId: id }))
  const at = chosen >= 0 && chosen < pictures.length ? chosen : -1
  const choose = (to: number) => () => update($, memberOf(pick, { requestId: id }), () => to)
  const isPair = pictures.length === 2
  // Two compare as both or either one; more compare each against the first
  const options: { to: number; label: string }[] =
    pictures.length < 2
      ? []
      : isPair
        ? [{ to: -1, label: 'Both' }, ...pictures.map((one, i) => ({ to: i, label: one.shot.label }))]
        : [{ to: -1, label: 'All' }, ...pictures.slice(1).map((one, i) => ({ to: i + 1, label: `vs ${one.shot.label}` }))]
  const chips = options.map(one => Choice(ui, `pick-${one.to}`, one.label, at === one.to, choose(one.to)))
  const shown = at < 0 ? pictures : isPair ? [pictures[at]!] : [pictures[0]!, pictures[at]!]
  const tile = (one: (typeof pictures)[number]) => ({ ...shot(one.shot.label, diskPic(one.base64)), ...(one.shot.isVideo ? { meta: 'video' } : {}) })
  const panes = Panes($, ui, `${id}-card`, shown.map(tile), wide(columns), 6, isPair || at >= 0 ? 2 : 3)
  const meta = pictures.length > 1 ? `${pictures.length} images` : pixels(diskPic(only.base64).size)
  const paths = pictures.map(one => one.shot.key).filter(key => key.startsWith('/'))
  const copy = paths.length > 0 ? [Link(ui, `${id}-copy`, 'Copy paths', press => $.ui.copy({ text: paths.join('\n'), surface: press.surface }))] : []
  const footer = { left: chips, right: copy, width: labelsWidth(options.map(one => one.label)) + (copy.length > 0 ? 3 + 'Copy paths'.length : 0) }
  const frame: FrameAt = {
    title: card.title ?? only.shot.label,
    meta,
    width: panes.width,
    max: wide(columns).columns,
    isUnread: pictures.some(one => one.shot.isUnread),
    footer,
  }
  return Frame(ui, frame, panes.tree)
}

async function cardsIn($: EngineInterface, calls: ReadonlyArray<ToolGroupCall>) {
  const all = await read($, cards)
  return calls.flatMap(call => {
    const card = call.tool_use_id ? all[call.tool_use_id] : undefined
    return call.tool_use_id && card ? [[call.tool_use_id, card] as const] : []
  })
}

// A video card's own facts: its caption, file, the site it draws in, and what the card shows beside it
type VideoAt = { note: string; path: string; site?: string; samples?: string; duration?: number; chapters?: ShowReadImageChapter[]; title?: string }

// Plays `video` into `site` from `from` seconds, decoding at `size` pixels; says so when this machine can't
async function startVideo($: EngineInterface, site: string, video: string, from: number, size: { width: number; height: number }) {
  const source = await playbackSource($, video, size, from, PLAYER_FPS, await convertedDir($))
  if (!source) {
    await $.ui.toast('show-read-image: playing a video needs clang on macOS, or ffmpeg')
    return
  }
  play($, site, video, from, size, source)
}

// ▶ Play  0:04 ━━━━━━●──────── 0:14: the word follows the clip's state; each stretch of the bar jumps there
function ScrubBar(ui: Ui, $: EngineInterface, prefix: string, p: ReturnType<typeof currentPlayback>, duration: number, width: number, start: (from: number) => unknown) {
  const { Box, Button, Text } = ui
  const position = p?.position ?? 0
  const state = !p ? 'idle' : p.status === 'playing' || p.status === 'starting' ? 'playing' : p.status === 'ended' ? 'ended' : 'paused'
  const word = playWord(state, position)
  const elapsed = clockOf(Math.min(position, duration), true)
  const total = clockOf(duration, true)
  const segments = Math.max(6, width - word.length - elapsed.length - total.length - 6)
  const playhead = duration > 0 ? Math.min(segments - 1, Math.round((position / duration) * (segments - 1))) : 0
  const toggle = () => {
    if (state === 'playing') {
      pausePlayback($)
    } else {
      void start(state === 'ended' ? 0 : position)
    }
  }
  return (
    <Box key={`${prefix}-bar`} flexDirection="row" flexWrap="nowrap">
      <Button key={state === 'playing' ? `${prefix}-pause` : `${prefix}-play`} plain label={word} onPress={toggle} />
      <Text dimColor>{` ${elapsed} `}</Text>
      {scrubChunks(segments, playhead).map((chunk, i) => (
        <Button
          key={`${prefix}-seek-${i}`}
          plain
          dimColor={chunk.isAhead}
          label={chunk.label}
          onPress={() => void start(duration > 0 ? (chunk.start / Math.max(1, segments - 1)) * duration : 0)}
        />
      ))}
      <Text dimColor>{` ${total}`}</Text>
    </Box>
  )
}

// What changed and when: each a link that plays the clip from there
function Chapters(ui: Ui, prefix: string, chapters: ShowReadImageChapter[], start: (from: number) => unknown) {
  const { Box, Text } = ui
  return (
    <Box key={`${prefix}-chapters`} flexDirection="column" width={chaptersWidth(chapters)} flexShrink={0}>
      <Text dimColor>Chapters</Text>
      {chapters.map((one, i) => (
        <Box key={`${prefix}-chapter-${i}`} flexDirection="row" justifyContent="space-between" gap={2}>
          <Text wrap="truncate-end">{`${i + 1}. ${one.label}`}</Text>
          {Link(ui, `${prefix}-chapter-${i}-at`, clockOf(one.at, true), () => start(one.at))}
        </Box>
      ))}
    </Box>
  )
}

function chaptersWidth(chapters: ShowReadImageChapter[]) {
  return Math.min(44, Math.max(...chapters.map((one, i) => `${i + 1}. ${one.label}`.length + 2 + clockOf(one.at, true).length)))
}

// A video's card: its frames at rest, the clip itself once played here, with the scrub bar and any chapters
async function drawVideo($: EngineInterface, ui: Ui, requestId: string, video: VideoAt, file: PngFile, stem: string, hint: string, isUnread: boolean, columns: number | undefined) {
  const { Box, Image, Text } = ui
  const site = video.site ?? requestId
  const playing = currentPlayback()
  const p = playing?.video === video.path && playing.site === site ? playing : undefined
  const chapters = video.chapters ?? []
  const side = chapters.length > 0 ? chaptersWidth(chapters) + 3 : 0
  const box = room(columns)
  const media = { columns: Math.max(20, box.columns - side), rows: box.rows }
  const decode = playerBox(media.columns, media.rows + 3, cellWidth, cell, 3)
  const start = (from: number) => startVideo($, site, video.path, from, decode)
  const frame = p ? (p.first ?? p.last) : undefined
  const picture = frame ?? file.base64
  const size = pngSize(picture) ?? sizeOf(file)
  const cells = fit(size, media.columns, media.rows, cell, frame ? Infinity : nativeColumns(size.width, cellWidth))
  const shown = frame
    ? <Image key={playerKey(cells.columns, cells.rows)} source={{ png: frame }} columns={cells.columns} rows={cells.rows} alt={`[video: ${stem}]`} />
    : <Image key={`strip-${cells.columns}x${cells.rows}-${fingerprint(file.base64).slice(0, 8)}`} source={{ png: file.base64 }} columns={cells.columns} rows={cells.rows} alt={`[video: ${stem}]`} />
  const duration = video.duration ?? 0
  const bar = p && duration > 0 ? [ScrubBar(ui, $, site, p, duration, cells.columns, start)] : []
  const samples = !p && video.samples ? [<Text key={`${requestId}-samples`} dimColor>{video.samples}</Text>] : []
  const body = (
    <Box key={`${requestId}-video`} flexDirection="row" gap={3}>
      <Box flexDirection="column" width={Math.max(cells.columns, !p && video.samples ? video.samples.length : 0)}>
        {shown}
        {bar}
        {samples}
      </Box>
      {chapters.length > 0 ? Chapters(ui, site, chapters, start) : null}
    </Box>
  )
  const actions = pictureActions($, ui, requestId, stem, file.base64, video.path, size, video.path, video.duration)
  // At rest the card offers to play; once played, Frames goes back to the grid
  const left = p
    ? [Choice(ui, `${site}-video`, 'Video', true, () => undefined), Link(ui, `${site}-frames`, 'Frames', () => stopPlayback($))]
    : [<ui.Button key={`${site}-play`} plain label="▶ Play" onPress={() => void start(0)} />]
  const footer = { left, right: actions.elements, width: labelsWidth(p ? ['Video', 'Frames'] : ['▶ Play']) + 3 + actions.width }
  const mediaWidth = Math.max(cells.columns, !p && video.samples ? video.samples.length : 0)
  const frameAt: FrameAt = { title: video.title ?? stem, hint, meta: video.note, width: mediaWidth + side, max: box.columns, isUnread, footer }
  return Frame(ui, frameAt, body)
}

let resizeTimer: { cancel: () => void } | undefined
let paneSize = ''

// The last size the pane reported, for checking how a resize reaches the mod
async function notePaneSize($: EngineInterface, columns: number, rows: number) {
  const size = `${columns}x${rows}`
  if (size !== paneSize) {
    paneSize = size
    await $.fs.write(`${await homeOf($)}/.cache/show-read-image/pane.txt`, `${size}\n`).catch(() => undefined)
  }
}
let wantedBox: { width: number; height: number } | undefined

// The Expand pane for a video: its filmstrip with [ play ], then live frames with pause, restart and the frame rate
async function drawPlayer($: EngineInterface, ui: Ui, columns: number, rows: number, video: string, label: string, strip: string, duration: number) {
  const { Box, Button, Image, Text } = ui
  const playing = currentPlayback()
  const p = playing?.video === video && playing.site === PANE ? playing : undefined
  const box = playerBox(columns, rows, cellWidth, cell, 4)
  const start = (from: number, size = box) => startVideo($, PANE, video, from, size)
  if (playing && !p) {
    // Expanded while its card was playing: the pane carries on from the same moment
    const handoff = playing.video === video && (playing.status === 'playing' || playing.status === 'starting') ? playing.position : undefined
    stopPlayback($)
    if (handoff !== undefined) {
      void start(handoff)
    }
  }
  // A resized pane decodes at its new size, from where it was, once the size has held for a moment: dragging the
  // pane's edge redraws many times, and restarting on each would decode a burst of short runs
  if (p?.status === 'playing' && p.box && (Math.abs(p.box.width - box.width) > 40 || Math.abs(p.box.height - box.height) > 40)) {
    wantedBox = box
    resizeTimer ??= $.clock.after(300, () => {
      resizeTimer = undefined
      const now = currentPlayback()
      if (now && now.status === 'playing' && wantedBox) {
        void start(now.position, wantedBox)
      }
    })
  }
  const frame = p?.first ?? p?.last
  const picture = frame ?? strip
  const cells = fit(pngSize(picture) ?? UNKNOWN, columns, Math.max(4, rows - 4), cell)
  const status = !p
    ? 'frames'
    : p.status === 'failed'
      ? `failed: ${p.error || 'the decoder stopped'}`
      : `${p.shownLastSecond} fps · ${p.dropped} dropped`
  const isRunning = p?.status === 'playing' || p?.status === 'starting'
  // Without a known length there's no bar to draw, only the play word
  const toggle = isRunning
    ? <Button key="player-pause" plain label="❚❚ Pause" onPress={() => pausePlayback($)} />
    : <Button key="player-play" plain label="▶ Play" onPress={() => void start(p && p.status === 'paused' ? p.position : 0)} />
  const bar = duration > 0 ? ScrubBar(ui, $, 'player', p, duration, Math.max(30, cells.columns), start) : toggle
  return (
    <Box flexDirection="column">
      {frame
        ? <Image key={playerKey(cells.columns, cells.rows)} source={{ png: frame }} columns={cells.columns} rows={cells.rows} alt={`[video: ${label}]`} />
        : <Image key={`player-strip-${cells.columns}x${cells.rows}`} source={{ png: strip }} columns={cells.columns} rows={cells.rows} alt={`[video: ${label}]`} />}
      {bar}
      {Bar(
        ui,
        [<Text key="player-label" bold>{label}</Text>, <Text key="player-status" dimColor>{status}</Text>],
        [Link(ui, 'player-restart', '↺ Restart', () => start(0)), Link(ui, 'pane-close', 'Close', () => $.ui.close({ id: PANE }))],
      )}
    </Box>
  )
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
        'Show image or video files to the user under this call, without loading them into your context. The card says they were not read by you, ' +
        'so Read an image instead when you need to see it yourself or make claims about it. One image draws on its own; several share one frame, ' +
        'side by side, in the order given. A video (.mov/.mp4/.m4v) shows as a grid of frames the user can play in place. Each item: path, ' +
        'optional label, optional version (0 = the file as it is now; -1 = the version kept before it, -2 the one before that), and for a video ' +
        'optional chapters ({ label, at } in seconds) to jump to.',
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
              properties: {
                path: { type: 'string' },
                label: { type: 'string' },
                version: { type: 'integer', maximum: 0 },
                chapters: {
                  type: 'array',
                  description: 'For a video: moments worth jumping to, listed beside the player, e.g. what changed and when.',
                  items: { type: 'object', properties: { label: { type: 'string' }, at: { type: 'number', description: 'seconds' } }, required: ['label', 'at'] },
                },
              },
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
    void notePaneSize($, e.props.bodyColumns, e.props.scroll.bodyRows)
    if (shown.video) {
      return drawPlayer($, ui, e.props.bodyColumns, e.props.scroll.bodyRows, shown.video, shown.label, base64, shown.duration ?? 0)
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
            <Text key="pane-at">{`${at + 1} of ${versions.length}`}</Text>,
            <Button key="pane-next" plain label="▶" dimColor={at === versions.length - 1} onPress={step(1)} />,
          ]
        : []
    return (
      <Box flexDirection="column">
        <Image key={`pane-${shown.hash.slice(0, 8)}-${cells.columns}x${cells.rows}`} source={{ png: base64 }} columns={cells.columns} rows={cells.rows} alt={`[image: ${shown.label}]`} />
        {Bar(
          ui,
          [
            <Text key="pane-label" bold>{shown.label}</Text>,
            <Text key="pane-size" dimColor>{pixels(shown.width && shown.height ? { width: shown.width, height: shown.height } : size)}</Text>,
            ...(stepper.length > 0 ? [<Box key="pane-stepper" flexDirection="row" gap={1}>{stepper}</Box>] : []),
          ],
          [Link(ui, 'pane-close', 'Close', () => $.ui.close({ id: PANE }))],
        )}
      </Box>
    )
  })

  // Closing the pane, or expanding something else, stops a playing video
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      stopPlayback($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

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
        drawn.push(await drawCard($, ui, id, card, e.viewport?.columns, e.requestId))
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
      const tree = await drawCard($, ui, id, card, columns, e.requestId)
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
      const tree = await drawCard($, ui, id, card, e.viewport?.columns, e.requestId)
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
