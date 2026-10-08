import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  holdSingleInstance,
  pinPackagedUserData,
  PACKAGED_USER_DATA_DIRECTORY,
  type InstanceApp
} from './instanceLocation'

function fakeApp(isPackaged: boolean, lock = true): InstanceApp & { paths: Map<string, string> } {
  const paths = new Map([
    ['appData', '/home/cashier/.config'],
    ['userData', '/home/cashier/.config/Thinis POS']
  ])
  return {
    isPackaged,
    paths,
    getPath: (name) => paths.get(name) as string,
    setPath: (name, path) => void paths.set(name, path),
    requestSingleInstanceLock: () => lock,
    quit: vi.fn(),
    on: vi.fn()
  }
}

describe('packaged userData location', () => {
  it('keeps a packaged till on the pos-desktop folder whatever its display name', () => {
    const app = fakeApp(true)

    expect(pinPackagedUserData(app)).toBe(
      join('/home/cashier/.config', PACKAGED_USER_DATA_DIRECTORY)
    )
  })

  it("leaves development and harness runs on Electron's default", () => {
    const app = fakeApp(false)

    expect(pinPackagedUserData(app)).toBe('/home/cashier/.config/Thinis POS')
  })
})

describe('single till process per profile', () => {
  it('quits a second process and lets the first bring its window forward', () => {
    const first = fakeApp(true, true)
    const focus = vi.fn()

    expect(holdSingleInstance(first, focus)).toBe(true)
    expect(first.on).toHaveBeenCalledWith('second-instance', focus)
    expect(first.quit).not.toHaveBeenCalled()

    const second = fakeApp(true, false)
    expect(holdSingleInstance(second, vi.fn())).toBe(false)
    expect(second.quit).toHaveBeenCalledTimes(1)
    expect(second.on).not.toHaveBeenCalled()
  })
})
