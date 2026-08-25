import type { DesktopShiftResource } from '../../http/desktopResources.contract'

/**
 * Contract fixture shared by main-process resource and service tests. It intentionally includes
 * every strict DesktopShiftResource member, so backend additions must be mirrored deliberately.
 */
export function desktopShiftFixture(
  overrides: Partial<DesktopShiftResource> = {}
): DesktopShiftResource {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    uuid: '22222222-2222-4222-8222-222222222222',
    status: 'open',
    company_id: 1,
    branch_id: 2,
    warehouse_id: 3,
    opening_cash_amount: 1000,
    expected_cash_amount: 1000,
    actual_cash_amount: null,
    cash_difference_amount: null,
    sales_total_amount: 0,
    refund_total_amount: 0,
    cash_sales_amount: 0,
    card_sales_amount: 0,
    other_payment_total_amount: 0,
    cash_movement_in_amount: 0,
    cash_movement_out_amount: 0,
    cash_movement_net_amount: 0,
    safe_drop_amount: 0,
    expense_payout_amount: 0,
    cash_drawer_movement_count: 0,
    opened_at: '2026-01-01T00:00:00Z',
    closed_at: null,
    paused_at: null,
    pause_count: 0,
    total_paused_seconds: 0,
    active_pause: null,
    notes: null,
    close_notes: null,
    ...overrides
  }
}
