/**
 * electron-builder `afterPack` hook: the packaged better-sqlite3 binary must match the TARGET
 * platform, or the installed till cannot open its database.
 *
 * `npm install` builds better-sqlite3 for the HOST (postinstall: electron-builder install-app-deps),
 * and `npmRebuild` does not cross-build. A Windows package built on Linux therefore carried the Linux
 * ELF binary. For a win32 target this hook installs better-sqlite3's own published prebuild for the
 * packaged Electron ABI (prebuild-install, from the module's GitHub release over HTTPS) when the
 * packaged binary is not already a Windows x64 DLL; for every target it then verifies the binary's
 * format and fails the build otherwise.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

const ARCH_NAMES = { 1: 'x64', 3: 'arm64', 0: 'ia32' } // electron-builder Arch enum

function binaryFormat(path) {
  const bytes = readFileSync(path)
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const machine = bytes.readUInt16LE(18)
    return {
      kind: 'elf',
      arch: machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : `0x${machine.toString(16)}`
    }
  }
  if (bytes.subarray(0, 2).toString('latin1') === 'MZ') {
    const pe = bytes.readUInt32LE(0x3c)
    if (bytes.subarray(pe, pe + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))) {
      const machine = bytes.readUInt16LE(pe + 4)
      return {
        kind: 'pe',
        arch:
          machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : `0x${machine.toString(16)}`
      }
    }
  }
  return { kind: 'unknown', arch: 'unknown' }
}

function expectedFormat(platform) {
  if (platform === 'win32') return 'pe'
  if (platform === 'linux') return 'elf'
  return 'macho'
}

export default async function afterPack(context) {
  const platform = context.electronPlatformName
  const arch = ARCH_NAMES[context.arch] ?? String(context.arch)
  const electronVersion =
    context.packager.config.electronVersion ?? context.packager.info.framework.version
  const resources =
    platform === 'darwin'
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources'
        )
      : join(context.appOutDir, 'resources')
  const moduleDir = join(resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3')
  const binary = join(moduleDir, 'build', 'Release', 'better_sqlite3.node')

  if (
    platform === 'win32' &&
    !(binaryFormat(binary).kind === 'pe' && binaryFormat(binary).arch === arch)
  ) {
    const scratch = mkdtempSync(join(tmpdir(), 'pos-desktop-prebuild-'))
    try {
      copyFileSync(require.resolve('better-sqlite3/package.json'), join(scratch, 'package.json'))
      execFileSync(
        process.execPath,
        [
          require.resolve('prebuild-install/bin.js'),
          '--runtime',
          'electron',
          '--target',
          electronVersion,
          '--platform',
          'win32',
          '--arch',
          arch
        ],
        { cwd: scratch, stdio: 'inherit' }
      )
      copyFileSync(join(scratch, 'build', 'Release', 'better_sqlite3.node'), binary)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  const format = binaryFormat(binary)
  if (format.kind !== expectedFormat(platform) || format.arch !== arch) {
    throw new Error(
      `better_sqlite3.node is ${format.kind}/${format.arch}, expected ${expectedFormat(platform)}/${arch} for ${platform}`
    )
  }
  console.log(
    `  • native module verified  better-sqlite3=${format.kind}/${format.arch} platform=${platform}`
  )
}
