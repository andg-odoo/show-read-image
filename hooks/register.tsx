import { atom, memberOf, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, ToolGroupCall } from 'claude-code'

import type { ShowReadImageHistory, ShowReadImageMode, ShowReadImageView } from '../types'
import {
  COMPACT,
  DEFAULT_CELL,
  EXPANDED,
  WIDE,
  addVersion,
  cellOf,
  fingerprint,
  fit,
  hashOf,
  historyDir,
  isPngPath,
  pack,
  pairOf,
  pathOf,
  pixels,
  pngOf,
  pngSize,
  sizeOf,
  sizeWarning,
  splitPath,
} from './logic'
import type { PngFile } from './logic'

type Ui = Elements['terminal']
type Box = { columns: number; rows: number }
type Size = { width: number; height: number }
type Shot = { title: string; meta: string; base64: string; size: Size }
type Read = { id: string; path: string; file: PngFile }
type Pic = { base64: string; size: Size }
type Pair = { stem: string; hint: string; before: Pic; after: Pic }

const history = atom({ plugin: 'show-read-image', key: 'history' } as const, {}, { shape: 'history-1' })
const step = atom({ plugin: 'show-read-image', key: 'step' } as const, -1)
const mode = atom({ plugin: 'show-read-image', key: 'mode' } as const, 'both' as ShowReadImageMode)
const view = atom({ plugin: 'show-read-image', key: 'view' } as const, 'now' as ShowReadImageView)

const MIN_FRAME = 30
const MAX_SIDE = 6
// The session's tty size in cells and pixels; a hook process has no tty of its own, so it opens /dev/tty
const WINSIZE = `perl -e 'open(T, "</dev/tty") or exit 1; my $w = " " x 8; ioctl(T, ($^O eq "darwin" ? 0x40087468 : 0x5413), $w) or exit 1; print join(" ", unpack("S4", $w))'`
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
let cell = DEFAULT_CELL
let measuredFor = ''

// Once per viewport size: the cell shape changes with the font, not with every draw
async function measure($: EngineInterface, viewport: { columns: number; rows: number } | undefined) {
  const key = `${viewport?.columns}x${viewport?.rows}`
  if (measuredFor === key) {
    return
  }
  measuredFor = key
  const ran = await $.process.run(['sh', '-c', WINSIZE]).catch(() => undefined)
  const next = (ran?.exitCode === 0 ? cellOf(ran.stdout) : undefined) ?? DEFAULT_CELL
  if (next !== cell) {
    cell = next
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
  home ??= (await $.env.get('HOME')) ?? '/tmp'
  return home
}

async function kept($: EngineInterface) {
  return (await read($, history)) as Record<string, ShowReadImageHistory>
}

async function readVersion($: EngineInterface, path: string, slot: number, hash: string) {
  const file = `${historyDir(await homeOf($), path)}/${slot}.b64`
  const key = `${file}:${hash}`
  let base64 = versionBytes.get(key)
  if (base64 === undefined) {
    base64 = String(await $.fs.read(file).catch(() => ''))
    if (!base64 || hashOf(base64) !== hash) {
      return undefined
    }
    versionBytes.set(key, base64)
  }
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
    diskBytes.set(path, { mtimeMs: stat.mtimeMs, base64 })
  }
  return base64
}

async function record($: EngineInterface, path: string, base64: string) {
  const hash = hashOf(base64)
  const added = addVersion((await kept($))[path], hash, await $.clock.now())
  if (!added) {
    return
  }
  await $.fs.write(`${historyDir(await homeOf($), path)}/${added.version.slot}.b64`, base64)
  const all = await update($, history, before => {
    const again = addVersion(before[path], hash, added.version.at)
    return again ? { ...before, [path]: again.entry } : before
  })
  await $.store.set('history', all)
}

function room(columns: number | undefined, isExpanded?: boolean): Box {
  const max = isExpanded ? EXPANDED : COMPACT
  return { columns: Math.max(20, Math.min(max.columns, (columns ?? 120) - 8)), rows: max.rows }
}

// Galleries and pairs take the transcript's width, two pictures a row
function wide(columns: number | undefined): Box {
  return { columns: Math.max(20, Math.min(WIDE.columns, (columns ?? 120) - 8)), rows: WIDE.rows }
}

function clock(at: number) {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function hintOf(path: string) {
  const { dir } = splitPath(path)
  return dir ? `${splitPath(dir).name}/` : ''
}

// The rounded dim border with its title bar: bold title, dim folder hint, dim meta on the right
function Frame(ui: Ui, at: { title: string; hint?: string; meta: string; width: number }, ...body: JSX.Element[]) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={Math.max(MIN_FRAME, at.width) + 4}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Box flexDirection="row" gap={1} flexShrink={1}>
          <Text bold wrap="truncate-end">{at.title}</Text>
          {at.hint ? <Text dimColor wrap="truncate-start">{at.hint}</Text> : null}
        </Box>
        <Text dimColor wrap="truncate-end">{at.meta}</Text>
      </Box>
      {body}
    </Box>
  )
}

// Pictures packed into rows, each with a small title over it
function Panes(ui: Ui, id: string, shots: Shot[], box: Box, minRows: number, perRow: number) {
  const { Box, Text, Image } = ui
  const rows = pack(shots.map(shot => shot.size.width / shot.size.height), box.columns, box.rows, minRows, perRow, 2, cell)
  const width = Math.max(...rows.map(row => row.reduce((sum, slot) => sum + slot.columns, 0) + 2 * (row.length - 1)))
  const tree = (
    <Box flexDirection="column" gap={1}>
      {rows.map((row, r) => (
        <Box key={`${id}-row-${r}`} flexDirection="row" gap={2}>
          {row.map(slot => {
            const shot = shots[slot.index]!
            const hasMeta = slot.columns >= shot.title.length + shot.meta.length + 1
            return (
              <Box key={`${id}-pane-${slot.index}`} flexDirection="column" width={slot.columns}>
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Text bold wrap="truncate-end">{shot.title}</Text>
                  {hasMeta ? <Text dimColor>{shot.meta}</Text> : null}
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
  const panes = Panes(ui, pair.stem, sides, box, 1, 2)
  const meta = ['before | after', sizeWarning(pair.before.size, pair.after.size)].filter(Boolean).join(' · ')
  const controls = (
    <Box flexDirection="row" gap={1}>
      {MODES.map(one => (
        <Button
          key={`mode-${one.mode}-${pair.stem}`}
          label={one.label}
          variant={one.mode === shown ? 'primary' : undefined}
          dimColor={one.mode !== shown}
          onPress={() => update($, memberOf(mode, { requestId }), () => one.mode)}
        />
      ))}
    </Box>
  )
  return Frame(ui, { title: pair.stem, hint: pair.hint, meta, width: panes.width }, controls, panes.tree)
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
  const versions = saved.some(one => one.hash === own) ? saved : [...saved, { hash: own, at: 0, slot: -1 }]
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
  const cells = fit(size, box.columns, box.rows, cell)
  const hasHistory = versions.length > 1
  const meta = [pixels(size), hasHistory ? `v${at + 1}/${versions.length}` : '', hasHistory && version.at ? clock(version.at) : '']
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
  const frame = { title: stem, hint: hintOf(path), meta, width: cells.columns }
  if (!hasHistory) {
    return Frame(ui, frame, image)
  }
  const shown = await read($, memberOf(view, { requestId }))
  const chip = (to: ShowReadImageView, label: string) => (
    <Button
      key={`view-${to}`}
      plain
      label={label}
      variant={shown === to ? 'primary' : undefined}
      dimColor={shown !== to}
      onPress={() => update($, memberOf(view, { requestId }), () => to)}
    />
  )
  const chips = [chip('now', 'Now'), chip('side', 'Side by side')]
  if (shown === 'side') {
    const first = Math.max(0, versions.length - MAX_SIDE)
    const shots: Shot[] = []
    for (let i = first; i < versions.length; i++) {
      const one = versions[i]!
      const bytes = i === ownAt ? file.base64 : one.slot < 0 ? undefined : await readVersion($, path, one.slot, one.hash)
      if (bytes) {
        const pic = i === ownAt ? picOf(file) : diskPic(bytes)
        shots.push(shot(i === ownAt ? 'Now' : `v${i + 1}`, pic))
      }
    }
    const panes = Panes(ui, `${requestId}-side`, shots, wide(columns), 6, 3)
    const note = first > 0 ? <Text dimColor>{`${first} older version(s) not shown`}</Text> : null
    return Frame(
      ui,
      { title: stem, hint: hintOf(path), meta: `${versions.length} versions`, width: panes.width },
      <Box flexDirection="row" gap={1}>{chips}</Box>,
      ...(note ? [note] : []),
      panes.tree,
    )
  }
  const controls = (
    <Box flexDirection="row" gap={1}>
      {chips}
      <Text dimColor>·</Text>
      <Button key="prev" plain label="◀" dimColor={at === 0} onPress={go(-1)} />
      <Button key="next" plain label="▶" dimColor={at === versions.length - 1} onPress={go(1)} />
      <Text dimColor>{at === ownAt ? 'as read here' : `older version, read here was v${ownAt + 1}`}</Text>
    </Box>
  )
  return Frame(ui, frame, controls, image)
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
    return next(e)
  })

  // Keeps each new content of a PNG path as a version so older ones can be drawn again
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    const file = ran.deny === undefined && !ran.isError ? pngOf('Read', ran.result) : undefined
    if (file && e.file_path) {
      paths.set(e.tool_use_id, e.file_path)
      await record($, e.file_path, file.base64).catch(() => undefined)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const reads = readsOf(e.props.calls)
    for (const one of reads) {
      mates.set(one.id, reads.map(other => other.path))
    }
    if (reads.length === 0 || e.props.isExpanded || e.surface !== 'terminal') {
      return next(e)
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
      const panes = Panes(ui, 'gallery', shots, wide(columns), 6, 2)
      const hints = [...new Set(rest.map(one => hintOf(one.path)))]
      const at = { title: `${shots.length} images`, hint: hints.length === 1 ? hints[0] : undefined, meta: `${rest.length} reads` }
      trees.push(Frame(ui, { ...at, width: panes.width }, panes.tree))
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
    if (!file || e.props.isErrored || e.surface !== 'terminal') {
      return next(e)
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
