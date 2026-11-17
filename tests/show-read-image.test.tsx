import { expect, mock, test } from 'claude-code/testing'

import { addVersion, cellOf, fit, pack, pairOf, pngSize, sizeWarning } from '../hooks/logic'

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
  // A taller cell needs fewer rows for the same picture
  expect(fit({ width: 1000, height: 1000 }, 40, 100)).toEqual({ columns: 40, rows: 20 })
  expect(fit({ width: 1000, height: 1000 }, 40, 100, 2.5)).toEqual({ columns: 40, rows: 16 })
  expect(pack([1, 1], 100, 100, 6, Infinity, 2, 2.5)[0]![0]).toEqual({ index: 0, columns: 48, rows: 19 })
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
  expect((await ui.find({ type: 'Text', text: /v2\/2/ }))?.text).toContain('8×4')
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: /v1\/2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /older version/ })).toBeDefined()
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
