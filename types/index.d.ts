export type ShowReadImageVersion = { hash: string; at: number; slot: number }

export type ShowReadImageHistory = { seq: number; versions: ShowReadImageVersion[] }

export type ShowReadImageMode = 'both' | 'after' | 'before'

export type ShowReadImageView = 'now' | 'side'

// `video`: the picture is this video's filmstrip, and the pane can play it
export type ShowReadImageExpanded = {
  label: string
  hash: string
  key?: string
  width?: number
  height?: number
  video?: string
  duration?: number
  chapters?: ShowReadImageChapter[]
}

// `width`/`height`: the source's own size, where the bytes kept are a scaled-down copy
// `note`: what a video's filmstrip stands for (length, frames, longest gap); `isVideo`: `key` is the video itself
// A labelled moment in a video, `at` seconds in, that the card lists beside the player
export type ShowReadImageChapter = { label: string; at: number }

export type ShowReadImageCardShot = {
  key: string
  label: string
  hash: string
  isUnread: boolean
  width?: number
  height?: number
  note?: string
  samples?: string
  isVideo?: boolean
  duration?: number
  chapters?: ShowReadImageChapter[]
}

// `isCommand`: made by a tool or command rather than shown on purpose; it is not drawn once a later Read shows it
// `failed`: pictures that couldn't be drawn, each `name: reason`, shown instead of a blank space
export type ShowReadImageCard = { title?: string; shots: ShowReadImageCardShot[]; at?: number; isCommand?: boolean; failed?: string[] }

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
