import type { BootstrapStatus } from '@shared/contracts/bootstrap.contract'

export type BootstrapDisplayState = BootstrapStatus | null

export const BOOTSTRAP_STAGES = ['idle', 'validating_access', 'downloading', 'complete'] as const
export type BootstrapStage = (typeof BOOTSTRAP_STAGES)[number]
