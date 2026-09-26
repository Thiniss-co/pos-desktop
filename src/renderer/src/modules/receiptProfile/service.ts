import type {
  ReceiptProfileChooseLogoOutput,
  ReceiptProfileGetOutput,
  ReceiptProfilePublishInput
} from '@shared/contracts/printing.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

/**
 * Receipt-printing plan §D-11 -- the renderer-side receipt-profile editor service. Every call is
 * narrow: `get`/`chooseLogo` take no argument at all (main resolves the session, the permission,
 * the file dialog and the upload itself), and `publish` sends field text plus a logo ACTION
 * (keep/remove/set-by-sha256) -- never a file path or raw image bytes.
 */
export class ReceiptProfileService {
  constructor(
    private readonly gateway: Window['posApi']['receiptProfile'] = window.posApi.receiptProfile
  ) {}

  async get(): Promise<ReceiptProfileGetOutput> {
    return unwrapIpcResult(await this.gateway.get())
  }

  async chooseLogo(): Promise<ReceiptProfileChooseLogoOutput> {
    return unwrapIpcResult(await this.gateway.chooseLogo())
  }

  async publish(input: ReceiptProfilePublishInput): Promise<ReceiptProfileGetOutput> {
    return unwrapIpcResult(await this.gateway.publish(input))
  }
}
