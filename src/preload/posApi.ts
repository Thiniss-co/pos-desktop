import { ipcRenderer } from 'electron'

export interface PosApi {
  readonly system: {
    ping(): void
    readonly versions: {
      readonly node: string
      readonly chrome: string
      readonly electron: string
    }
  }
}

export const posApi: PosApi = Object.freeze({
  system: Object.freeze({
    ping(): void {
      ipcRenderer.send('ping')
    },
    versions: Object.freeze({
      node: process.versions.node,
      chrome: process.versions.chrome,
      electron: process.versions.electron
    })
  })
})
