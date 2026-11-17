export type ShowReadImageVersion = { hash: string; at: number; slot: number }

export type ShowReadImageHistory = { seq: number; versions: ShowReadImageVersion[] }

export type ShowReadImageMode = 'both' | 'after' | 'before'

export type ShowReadImageView = 'now' | 'side'

export type ShowReadImageCardShot = { key: string; label: string; hash: string; isUnread: boolean }

export type ShowReadImageCard = { title?: string; shots: ShowReadImageCardShot[] }

declare module 'claude-code' {
  interface PluginState {
    'show-read-image': {
      history: Shaped<Record<string, ShowReadImageHistory>>
      step: StateFamily<number>
      mode: StateFamily<ShowReadImageMode>
      view: StateFamily<ShowReadImageView>
      cards: Shaped<Record<string, ShowReadImageCard>>
    }
  }
}
