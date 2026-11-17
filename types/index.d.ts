export type ShowReadImageVersion = { hash: string; at: number; slot: number }

export type ShowReadImageHistory = { seq: number; versions: ShowReadImageVersion[] }

export type ShowReadImageMode = 'both' | 'after' | 'before'

export type ShowReadImageView = 'now' | 'side'

export type ShowReadImageExpanded = { label: string; hash: string; key?: string; width?: number; height?: number }

// `width`/`height`: the source's own size, where the bytes kept are a scaled-down copy
// `note`: what a video's filmstrip stands for (length, frames, longest gap); `isVideo`: `key` is the video itself
export type ShowReadImageCardShot = {
  key: string
  label: string
  hash: string
  isUnread: boolean
  width?: number
  height?: number
  note?: string
  isVideo?: boolean
}

// `isCommand`: made by a tool or command rather than shown on purpose; it is not drawn once a later Read shows it
export type ShowReadImageCard = { title?: string; shots: ShowReadImageCardShot[]; at?: number; isCommand?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'show-read-image': {
      history: Shaped<Record<string, ShowReadImageHistory>>
      step: StateFamily<number>
      mode: StateFamily<ShowReadImageMode>
      view: StateFamily<ShowReadImageView>
      pick: StateFamily<number>
      seen: Shaped<Record<string, number>>
      expanded: Shaped<ShowReadImageExpanded | null>
      cards: Shaped<Record<string, ShowReadImageCard>>
    }
  }
}
