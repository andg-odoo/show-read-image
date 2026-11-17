import { expect, mock, test } from 'claude-code/testing'

import { addVersion, cellFromTmux, cellOf, commandKind, nativeColumns, fit, imageBlocks, imagePathsIn, pack, pairOf, pngSize, sizeWarning } from '../hooks/logic'

// The test runtime has timers; the mod's lib leaves them out
declare const setTimeout: (done: () => void, ms: number) => unknown

const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEklEQVR4nGP4z8CAFWEXJUsCAFpeH+EeQoQoAAAAAElFTkSuQmCC'
const BLUE = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEElEQVR4nGNgYPiPA1FNAgAanh/hASyMewAAAABJRU5ErkJggg=='
const GREEN = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAD0lEQVR4nGNg+M+AQMRxAJ6jD/Flt2QIAAAAAElFTkSuQmCC'

const image = (base64: string) => ({ type: 'image', file: { base64, type: 'image/png', originalSize: 90 } })

const call = (id: string, path: string, base64: string) => ({
  tool_use_id: id,
  tool: 'Read',
  input: { file_path: path },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: image(base64),
})

test('pairing, sizes, packing and versions', () => {
  expect(pairOf('/s/shot.after.png')).toEqual({
    side: 'after',
    stem: 'shot',
    before: '/s/shot.before.png',
    after: '/s/shot.after.png',
  })
  expect(pairOf('/s/shot.png')).toBeUndefined()
  expect(pngSize(RED)).toEqual({ width: 8, height: 4 })
  // Two 2:1 pictures share 100 columns on one row
  expect(pack([2, 2], 100, 25)).toEqual([
    [
      { index: 0, columns: 48, rows: 12 },
      { index: 1, columns: 48, rows: 12 },
    ],
  ])
  expect(pack([4, 4, 4], 60, 25).length).toBe(3)
  expect(pack([2, 2, 2], 192, 30, 6, 2).map(row => row.length)).toEqual([2, 1])
  expect(sizeWarning({ width: 1600, height: 954 }, { width: 1692, height: 740 })).toBe('sizes differ (1600×954 vs 1692×740)')
  expect(sizeWarning({ width: 1600, height: 954 }, { width: 1610, height: 950 })).toBe('')
  const first = addVersion(undefined, 'a', 1)!
  expect(first.entry).toEqual({ seq: 1, versions: [{ hash: 'a', at: 1, slot: 0 }] })
  expect(addVersion(first.entry, 'a', 2)).toBeUndefined()
  let entry = first.entry
  for (let n = 0; n < 12; n++) {
    entry = addVersion(entry, `h${n}`, n)!.entry
  }
  expect(entry.versions.length).toBe(10)
  expect(entry.versions[9]).toEqual({ hash: 'h11', at: 11, slot: 2 })
})

test('the cell shape comes from the tty and falls back to 2:1', () => {
  expect(Math.round(cellOf('50 200 3400 1900')! * 1000)).toBe(2235)
  expect(cellOf('50 200 0 0')).toBeUndefined()
  expect(cellOf('')).toBeUndefined()
  expect(cellOf('50 200 200 5000')).toBeUndefined()
  expect(cellFromTmux('10 21\n')).toEqual({ width: 10, height: 21 })
  expect(cellFromTmux('0 0')).toBeUndefined()
  // A taller cell needs fewer rows for the same picture
  expect(fit({ width: 1000, height: 1000 }, 40, 100)).toEqual({ columns: 40, rows: 20 })
  expect(fit({ width: 1000, height: 1000 }, 40, 100, 2.5)).toEqual({ columns: 40, rows: 16 })
  expect(pack([1, 1], 100, 100, 6, Infinity, 2, 2.5)[0]![0]).toEqual({ index: 0, columns: 48, rows: 19 })
})

test('small pictures draw up to twice their pixels, large ones at their own size', () => {
  expect(nativeColumns(240, 10)).toBe(48)
  expect(nativeColumns(600, 10)).toBe(80)
  expect(nativeColumns(1000, 10)).toBe(100)
  expect(nativeColumns(40, 10)).toBe(16)
  expect(fit({ width: 240, height: 160 }, 100, 30, 2, nativeColumns(240, 10))).toEqual({ columns: 48, rows: 16 })
  // A 400×100 before and a 200×200 after share the shorter one's allowed height instead of enlarging it further
  const [row] = pack([4, 1], 200, 30, 1, 2, 2, 2, [nativeColumns(400, 10), nativeColumns(200, 10)])
  expect(row).toEqual([
    { index: 0, columns: 80, rows: 10 },
    { index: 1, columns: 20, rows: 10 },
  ])
})

test('a read PNG is kept once per content and stepped through', async ($, on) => {
  const written = new Map<string, string>()
  let next = RED
  mock.clock(on, { now: Date.UTC(2026, 9, 26, 12) })
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  on('fs.write', (_, e) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => ({ value: written.get(e.path) ?? '' }))
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  on('tool.call', () => ({ result: image(next) }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })

  await $.tool.call({ tool: 'Read', file_path: '/s/shot.png' })
  await $.tool.call({ tool: 'Read', file_path: '/s/shot.png' })
  next = BLUE
  await $.tool.call({ tool: 'Read', file_path: '/s/shot.png' })
  expect([...written.values()]).toEqual([RED, BLUE])

  const ui = await $.ui.mount({
    plugin: 'show-read-image',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'read-2',
    viewport: { columns: 120, rows: 40 },
    props: call('read-2', '/s/shot.png', BLUE),
  })
  expect(await ui.find({ type: 'Text', text: 'v2/2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /8×4/ })).toBeDefined()
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: /v1\/2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /older version/ })).toBeDefined()
  // The frame fits its controls, `[ now ] [ side by side ]   ◀ v1/2 ▶   older version, …`, not just the 8×4 picture
  const frame = (await ui.findAll({ type: 'Box' })).find(found => found.props.borderStyle === 'round')
  expect(Number(frame?.props.width)).toBeGreaterThanOrEqual(24 + 3 + 8 + 3 + 'older version, read here was v2'.length + 4)
  await ui.press({ key: 'view-side' })
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: 'Now' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'v1' })).toBeDefined()
  await ui.press({ key: 'view-now' })
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(1)
  await ui.unmount()
})

test('a group of a before and an after read draws one pair with its toggle', async ($, on) => {
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine line</Text>
  })
  const ui = await $.ui.mount({
    plugin: 'show-read-image',
    surface: 'terminal',
    component: 'ToolGroup',
    viewport: { columns: 120, rows: 40 },
    props: {
      calls: [call('a', '/s/shot.before.png', RED), call('b', '/s/shot.after.png', BLUE)],
      isActive: false,
      isExpanded: false,
    },
  })
  expect(await ui.find({ type: 'Text', text: 'engine line' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'before | after' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sizes differ/ })).toBeUndefined()
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(2)
  await ui.press({ key: 'mode-after-shot' })
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: 'Before' })).toBeUndefined()
  await ui.unmount()
})

test('a mixed group draws its pair frame first, then a gallery of the rest', async ($, on) => {
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine line</Text>
  })
  const calls = [
    call('a', '/s/one.png', RED),
    call('b', '/s/shot.before.png', RED),
    call('c', '/s/two.png', BLUE),
    call('d', '/s/shot.after.png', GREEN),
  ]
  const group = await $.ui.mount({
    plugin: 'show-read-image',
    surface: 'terminal',
    component: 'ToolGroup',
    viewport: { columns: 120, rows: 40 },
    props: { calls, isActive: false, isExpanded: false },
  })
  expect((await group.find({ type: 'Text', text: /before \| after/ }))?.text).toContain('sizes differ (8×4 vs 4×4)')
  expect(await group.find({ type: 'Text', text: '2 images' })).toBeDefined()
  expect(await group.findAll({ type: 'Image' })).toHaveLength(4)
  expect(await group.findAll({ type: 'Button' })).toHaveLength(3)
  await group.unmount()

  // In ctrl+o rows the before row draws no picture of its own
  const row = await $.ui.mount({
    plugin: 'show-read-image',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'b',
    viewport: { columns: 120, rows: 40 },
    props: { ...calls[1]!, isExpanded: true },
  })
  expect(await row.findAll({ type: 'Image' })).toHaveLength(0)
  await row.unmount()
})

test('image paths come from what a command printed or, for an image maker, what it named', () => {
  expect(commandKind('screencapture -x /tmp/a.png')).toBe('maker')
  expect(commandKind('cd /w && xcrun simctl io booted screenshot /tmp/s.png')).toBe('maker')
  expect(commandKind('FOO=1 magick in.jpg /tmp/out.png')).toBe('maker')
  expect(commandKind('ls -la shots/')).toBe('listing')
  expect(commandKind('git status --short')).toBe('listing')
  expect(commandKind('rg -l png src')).toBe('listing')
  expect(commandKind('npm run build')).toBe('other')

  expect(imagePathsIn('', 'screencapture -x "/tmp/a.png"')).toEqual(['/tmp/a.png'])
  expect(imagePathsIn('Wrote screenshot to: /tmp/s.png', 'xcrun simctl io booted screenshot /tmp/s.png')).toEqual(['/tmp/s.png'])
  expect(imagePathsIn('/w/shots/a.png\n/w/shots/b.png', 'ls /w/shots/*.png')).toEqual([])
  expect(imagePathsIn('saved /tmp/chart.png', 'python plot.py')).toEqual(['/tmp/chart.png'])
  // A build naming an image in its arguments did not necessarily make it
  expect(imagePathsIn('', 'cp /a/in.png /b/out.png')).toEqual([])
  // A maker's image is its last image argument, resolved against where it ran
  expect(imagePathsIn('', 'sips -s format jpeg /a/in.png --out /b/out.jpg')).toEqual(['/b/out.jpg'])
  expect(imagePathsIn('', 'magick in.jpg out.png', '/work', '/home/me')).toEqual(['/work/out.png'])
  expect(imagePathsIn('', 'cd ~/shots && screencapture -x now.png', '/work', '/home/me')).toEqual(['/home/me/shots/now.png'])
  expect(imagePathsIn('', 'screencapture -x $OUT/now.png', '/work', '/home/me')).toEqual([])
  expect(imagePathsIn(JSON.stringify({ screenshotPath: '/t/full.png', thumbnailPath: '/t/thumb.png' }))).toEqual(['/t/full.png'])
  expect(imagePathsIn('/a/1.png /a/2.png /a/3.png /a/4.png /a/5.png', 'make shots')).toHaveLength(4)

  expect(imageBlocks([{ type: 'text', text: 'hi' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }])).toEqual([
    { base64: 'AAAA', mime: 'image/jpeg' },
  ])
  expect(imageBlocks({ content: [{ type: 'image', source: { data: 'BBBB', media_type: 'image/png' } }] })).toEqual([
    { base64: 'BBBB', mime: 'image/png' },
  ])
})

test('a screenshot a Bash command wrote draws under its row, marked as not read', async ($, on) => {
  const written = new Map<string, string>()
  mock.clock(on, { now: Date.UTC(2026, 10, 17, 12) })
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  on('fs.write', (_, e) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    if (e.path !== '/tmp/s.png' && e.path !== '/tmp/old.png') {
      throw new Error('ENOENT')
    }
    // old.png was there before the command ran
    const mtimeMs = e.path === '/tmp/old.png' ? 1 : Date.UTC(2026, 10, 17, 12)
    return { value: { kind: 'file' as const, size: 90, mtimeMs, isLink: false } }
  })
  on('fs.read', (_, e) => (e.path === '/tmp/s.png' ? { value: { base64: RED } } : { value: written.get(e.path) ?? '' }))
  on('tool.call', (_, e) => {
    if (e.tool === 'Read') {
      return { result: { type: 'image', file: { base64: RED, type: 'image/png', originalSize: 90 } } }
    }
    const command = String((e as unknown as { command?: string }).command ?? '')
    return { result: 'ok', text: command.includes('screenshot') ? 'Wrote screenshot to: /tmp/s.png' : '' }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })

  await $.tool.call({ tool: 'Bash', command: 'xcrun simctl io booted screenshot /tmp/s.png', tool_use_id: 'bash-1' })
  const ui = await $.ui.mount({
    plugin: 'show-read-image',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'bash-1',
    viewport: { columns: 120, rows: 40 },
    props: { tool_use_id: 'bash-1', tool: 'Bash', input: { command: 'x' }, isRunning: false, isErrored: false, isInterrupted: false, output: 'ok' },
  })
  let image = await ui.find({ type: 'Image' })
  for (let tries = 0; !image && tries < 20; tries++) {
    await new Promise<void>(done => setTimeout(done, 10))
    image = await ui.find({ type: 'Image' })
  }
  expect(image).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /not read by the agent/ }))?.text).toContain('8×4')
  await ui.unmount()

  // Once a Read shows the same picture, the command's card folds to one line
  await $.tool.call({ tool: 'Read', file_path: '/tmp/s.png', tool_use_id: 'read-s' })
  const folded = await $.ui.mount({
    plugin: 'show-read-image',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'bash-1',
    viewport: { columns: 120, rows: 40 },
    props: { tool_use_id: 'bash-1', tool: 'Bash', input: { command: 'x' }, isRunning: false, isErrored: false, isInterrupted: false, output: 'ok' },
  })
  expect(await folded.findAll({ type: 'Image' })).toHaveLength(0)
  expect(await folded.find({ type: 'Text', text: /s\.png · shown by a Read below/ })).toBeDefined()
  await folded.unmount()

  await $.tool.call({ tool: 'Bash', command: 'sips -Z 64 /tmp/old.png', tool_use_id: 'bash-2' })
  await new Promise<void>(done => setTimeout(done, 30))
  const stale = await $.ui.mount({
    plugin: 'show-read-image',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'bash-2',
    viewport: { columns: 120, rows: 40 },
    props: { tool_use_id: 'bash-2', tool: 'Bash', input: { command: 'x' }, isRunning: false, isErrored: false, isInterrupted: false, output: 'ok' },
  })
  expect(await stale.findAll({ type: 'Image' })).toHaveLength(0)
  await stale.unmount()
})

test('show_images draws a titled, unread card and can step back a version', async ($, on) => {
  const written = new Map<string, string>()
  const disk = new Map([['/s/a.png', RED], ['/s/b.png', GREEN]])
  let edits = 1
  mock.clock(on, { now: Date.UTC(2026, 10, 17, 12) })
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  on('fs.write', (_, e) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    if (!disk.has(e.path)) {
      throw new Error('ENOENT')
    }
    return { value: { kind: 'file' as const, size: 90, mtimeMs: edits, isLink: false } }
  })
  on('fs.read', (_, e) => (disk.has(e.path) ? { value: { base64: disk.get(e.path)! } } : { value: written.get(e.path) ?? '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  const mount = (id: string) =>
    $.ui.mount({
      plugin: 'show-read-image',
      surface: 'terminal',
      component: 'ToolUse',
      requestId: id,
      viewport: { columns: 120, rows: 40 },
      props: { tool_use_id: id, tool: 'mcp__show-read-image__show_images', input: {}, isRunning: false, isErrored: false, isInterrupted: false, output: '' },
    })

  const tool = 'mcp__show-read-image__show_images'
  const first = await $.tool.call({ tool, tool_use_id: 'show-1', title: 'Before and after', images: [{ path: '/s/a.png', label: 'Before' }, { path: '/s/b.png', label: 'After' }] })
  expect(String(first.result)).toContain('Shown 2 image(s)')
  const card = await mount('show-1')
  expect(await card.find({ type: 'Text', text: 'Before and after' })).toBeDefined()
  expect((await card.find({ type: 'Text', text: /not read by the agent/ }))?.text).toContain('2 images')
  expect(await card.findAll({ type: 'Image' })).toHaveLength(2)
  await card.unmount()

  disk.set('/s/a.png', BLUE)
  edits += 1
  await $.tool.call({ tool, tool_use_id: 'show-2', images: [{ path: '/s/a.png', version: -1, label: 'previous' }] })
  const back = await mount('show-2')
  expect(await back.find({ type: 'Text', text: 'v1/2' })).toBeDefined()
  expect(await back.find({ type: 'Text', text: /not read by the agent/ })).toBeDefined()

  expect((await back.findAll({ type: 'Image' })).map(found => (found.props.source as { png?: string }).png)).toEqual([RED])
  const clamped = await $.tool.call({ tool, tool_use_id: 'show-4', images: [{ path: '/s/a.png', version: -5 }] })
  expect(String(clamped.result)).toContain('showing the oldest')

  const three = await $.tool.call({
    tool,
    tool_use_id: 'show-5',
    images: [{ path: '/s/a.png', label: 'A' }, { path: '/s/b.png', label: 'B' }, { path: '/s/a.png', label: 'C', version: -1 }],
  })
  expect(String(three.result)).toContain('Shown 3 image(s)')
  const compare = await mount('show-5')
  expect(await compare.findAll({ type: 'Image' })).toHaveLength(3)
  await compare.press({ key: 'pick-2' })
  expect((await compare.findAll({ type: 'Image' })).map(found => (found.props.source as { png?: string }).png)).toEqual([BLUE, RED])
  await compare.press({ key: 'pick--1' })
  expect(await compare.findAll({ type: 'Image' })).toHaveLength(3)
  await compare.unmount()

  const pair = await mount('show-1')
  await pair.press({ key: 'pick-1' })
  expect((await pair.findAll({ type: 'Image' })).map(found => (found.props.source as { png?: string }).png)).toEqual([GREEN])
  await pair.unmount()

  const missing = await $.tool.call({ tool, tool_use_id: 'show-3', images: [{ path: '/s/none.png' }] })
  expect(String(missing.result)).toContain('Could not show: /s/none.png')
  await back.unmount()
})

test('a tool card still draws after its path has kept ten newer versions, and Glob makes none', async ($, on) => {
  const written = new Map<string, string>()
  let content = RED
  let edits = 1
  mock.clock(on, { now: Date.UTC(2026, 10, 17, 12) })
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  on('fs.write', (_, e) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    if (e.path !== '/tmp/s.png') {
      throw new Error('ENOENT')
    }
    return { value: { kind: 'file' as const, size: 90, mtimeMs: Date.UTC(2026, 10, 17, 12) + edits, isLink: false } }
  })
  on('fs.read', (_, e) => (e.path === '/tmp/s.png' ? { value: { base64: content } } : { value: written.get(e.path) ?? '' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: 'ok', text: 'Wrote screenshot to: /tmp/s.png' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>(done => setTimeout(done, 5))
    }
  }

  await $.tool.call({ tool: 'Bash', command: 'xcrun simctl io booted screenshot /tmp/s.png', tool_use_id: 'first' })
  await settle()
  for (let n = 0; n < 11; n++) {
    content = `${RED.slice(0, -4)}${String(n).padStart(2, '0')}==`
    edits += 1
    await $.tool.call({ tool: 'Bash', command: 'xcrun simctl io booted screenshot /tmp/s.png', tool_use_id: `later-${n}` })
    await settle()
  }
  // Glob is a host tool this build's typings do not list
  await $.tool.call({ tool: 'Glob', pattern: '**/*.png', tool_use_id: 'glob-1' } as never)
  await settle()

  const mount = (id: string, tool: string) =>
    $.ui.mount({
      plugin: 'show-read-image',
      surface: 'terminal',
      component: 'ToolUse',
      requestId: id,
      viewport: { columns: 120, rows: 40 },
      props: { tool_use_id: id, tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false, output: 'ok' },
    })
  const first = await mount('first', 'Bash')
  expect((await first.findAll({ type: 'Image' })).map(found => (found.props.source as { png?: string }).png)).toEqual([RED])
  expect(await first.find({ type: 'Text', text: /older than the kept versions/ })).toBeDefined()
  await first.unmount()
  const glob = await mount('glob-1', 'Glob')
  expect(await glob.findAll({ type: 'Image' })).toHaveLength(0)
  await glob.unmount()
})

test('a command that made the pair a group then reads draws it once', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 10, 17, 12) })
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  const disk = new Map([['/s/btn.before.png', RED], ['/s/btn.after.png', BLUE]])
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', (_, e) => {
    if (!disk.has(e.path)) {
      throw new Error('ENOENT')
    }
    return { value: { kind: 'file' as const, size: 90, mtimeMs: Date.UTC(2026, 10, 17, 12), isLink: false } }
  })
  on('fs.read', (_, e) => ({ value: { base64: disk.get(e.path) ?? '' } }))
  on('tool.call', () => ({ result: 'ok', text: '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine line</Text>
  })
  await $.tool.call({ tool: 'Bash', command: 'convert -size 8x4 xc:red /s/btn.before.png && convert -size 8x4 xc:blue /s/btn.after.png', tool_use_id: 'make' })
  await new Promise<void>(done => setTimeout(done, 30))
  const group = await $.ui.mount({
    plugin: 'show-read-image',
    surface: 'terminal',
    component: 'ToolGroup',
    viewport: { columns: 120, rows: 40 },
    props: {
      calls: [
        { tool_use_id: 'make', tool: 'Bash', input: { command: 'convert …' }, isRunning: false, isErrored: false, isInterrupted: false, output: 'ok' },
        call('a', '/s/btn.before.png', RED),
        call('b', '/s/btn.after.png', BLUE),
      ],
      isActive: false,
      isExpanded: false,
    },
  })
  expect(await group.find({ type: 'Text', text: 'before | after' })).toBeDefined()
  expect(await group.findAll({ type: 'Image' })).toHaveLength(2)
  await group.unmount()
})
