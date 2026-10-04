import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import type { ApplicationServices } from '../app/applicationServices'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown> | unknown
  >()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(
      (
        channel: string,
        handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown> | unknown
      ) => {
        handlers.set(channel, handler)
      }
    )
  }
}))

const { assertTrustedSender } = vi.hoisted(() => ({ assertTrustedSender: vi.fn() }))
vi.mock('./assertTrustedSender', () => ({ assertTrustedSender }))

import { registerQuickCreateIpcHandlers } from './quickCreate.ipc'

const event = {} as IpcMainInvokeEvent
const access = { available: true, customer: true, supplier: false, product: false }

describe('quick-create IPC', () => {
  beforeEach(() => {
    handlers.clear()
    assertTrustedSender.mockReset()
    registerQuickCreateIpcHandlers({
      quickCreateAccess: { access: () => access }
    } as unknown as ApplicationServices)
  })

  it('answers get-access from main, never from renderer input', async () => {
    const handler = handlers.get(IPC_CHANNELS.quickCreateGetAccess)!
    await expect(handler(event, undefined)).resolves.toEqual({ ok: true, data: access })
  })

  it('refuses any payload (a direct IPC bypass attempt cannot choose a user or a permission)', async () => {
    const handler = handlers.get(IPC_CHANNELS.quickCreateGetAccess)!
    await expect(handler(event, { userUuid: 'x', customer: true })).resolves.toMatchObject({
      ok: false,
      error: { category: 'validation' }
    })
  })

  it('refuses an untrusted sender', async () => {
    assertTrustedSender.mockImplementation(() => {
      throw new Error('untrusted')
    })
    const handler = handlers.get(IPC_CHANNELS.quickCreateGetAccess)!
    await expect(Promise.resolve(handler(event, undefined))).resolves.toMatchObject({ ok: false })
  })
})
