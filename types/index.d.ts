export type ShowReadImageVersion = { hash: string; at: number; slot: number }

export type ShowReadImageHistory = { seq: number; versions: ShowReadImageVersion[] }

export type ShowReadImageMode = 'both' | 'after' | 'before'

export type ShowReadImageView = 'now' | 'side'

export type ShowReadImageExpanded = { label: string; hash: string; key?: string }

export type ShowReadImageCardShot = { key: string; label: string; hash: string; isUnread: boolean }

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
