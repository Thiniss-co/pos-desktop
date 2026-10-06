import { createHash } from 'node:crypto'
import {
  POS_WORKSPACE_LAYOUT_VERSION,
  defaultWorkspaceLayout,
  parseStoredWorkspaceLayout,
  type PosWorkspaceReadResult,
  type SetPosWorkspaceInput
} from '@shared/contracts/posWorkspace.contract'
import { createPublicError } from '../http/apiError'
import type {
  WorkspaceLayoutOwner,
  WorkspaceLayoutRepository
} from '../repositories/workspaceLayout.repository'

export interface WorkspaceLayoutDependencies {
  readonly session: {
    getContext(): {
      readonly isAuthenticated: boolean
      readonly companyUuid: string | null
      readonly userUuid: string | null
      readonly deviceUuid: string | null
      readonly serverDeviceId?: string | number | null
    }
  }
  readonly epoch: { current(): number }
  readonly repository: Pick<WorkspaceLayoutRepository, 'get' | 'set' | 'delete'>
  readonly now?: () => Date
}

/**
 * POS workspace layout for the signed-in user on this workstation. The owner (company, user and
 * device) is always derived from the main-process session; nothing in a request can choose it.
 *
 * Every read returns a context token covering the full session context. A write is accepted only
 * when its token still matches the context at the moment of writing, so a save that started under
 * one sign-in can never be written to another user's (or company's, or device's) row.
 */
export class WorkspaceLayoutService {
  constructor(private readonly dependencies: WorkspaceLayoutDependencies) {}

  read(): PosWorkspaceReadResult {
    const context = this.context()

    if (context === null) {
      return { layout: defaultWorkspaceLayout(), stored: false, contextToken: null }
    }

    const stored = this.dependencies.repository.get(context.owner)
    return {
      layout: parseStoredWorkspaceLayout(stored),
      stored: stored !== null,
      contextToken: context.token
    }
  }

  write(input: SetPosWorkspaceInput): PosWorkspaceReadResult {
    const context = this.context()

    if (context === null) {
      throw createPublicError('authentication', 'Sign in to change your workspace layout.', false)
    }

    if (input.contextToken !== context.token) {
      throw createPublicError(
        'conflict',
        'The signed-in session changed. Your layout was not saved; reopen the layout editor.',
        false
      )
    }

    if (input.layout === null) {
      this.dependencies.repository.delete(context.owner)
    } else {
      this.dependencies.repository.set(
        context.owner,
        JSON.stringify(input.layout),
        POS_WORKSPACE_LAYOUT_VERSION,
        (this.dependencies.now?.() ?? new Date()).toISOString()
      )
    }

    return this.read()
  }

  private context(): { owner: WorkspaceLayoutOwner; token: string } | null {
    const session = this.dependencies.session.getContext()

    if (
      !session.isAuthenticated ||
      !session.companyUuid ||
      !session.userUuid ||
      !session.deviceUuid
    ) {
      return null
    }

    const owner = {
      companyUuid: session.companyUuid,
      userUuid: session.userUuid,
      deviceUuid: session.deviceUuid
    }
    const token = createHash('sha256')
      .update(
        JSON.stringify([
          owner.companyUuid,
          owner.userUuid,
          owner.deviceUuid,
          session.serverDeviceId ?? null,
          this.dependencies.epoch.current()
        ])
      )
      .digest('hex')
      .slice(0, 32)

    return { owner, token }
  }
}
