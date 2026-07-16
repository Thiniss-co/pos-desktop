import type { SessionSummary } from '@shared/contracts/auth.contract'

export interface SessionMetadataRepository {
  getSummary(): SessionSummary
}

export class SessionService {
  constructor(private readonly repository: SessionMetadataRepository) {}

  getSummary(): SessionSummary {
    return this.repository.getSummary()
  }
}
