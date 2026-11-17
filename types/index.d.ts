export type ShowReadImageVersion = { hash: string; at: number; slot: number }

export type ShowReadImageHistory = { seq: number; versions: ShowReadImageVersion[] }

export type ShowReadImageMode = 'both' | 'after' | 'before'

declare module 'claude-code' {
  interface PluginState {
    'show-read-image': {
      history: Shaped<Record<string, ShowReadImageHistory>>
      step: StateFamily<number>
      mode: StateFamily<ShowReadImageMode>
    }
  }
}
