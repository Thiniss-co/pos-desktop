import type { DesktopBootstrapResource } from '../../http/desktopResources.contract'

export function desktopBootstrapFixture(
  overrides: Partial<DesktopBootstrapResource> = {}
): DesktopBootstrapResource {
  return {
    server_time: '2026-01-01T00:00:00+00:00',
    company: { id: '11111111-1111-4111-8111-111111111111', name: 'Example Shop', is_active: true },
    device: {
      id: '22222222-2222-4222-8222-222222222222',
      device_uuid: '33333333-3333-4333-8333-333333333333',
      device_name: 'Example Register',
      platform: 'linux',
      status: 'active',
      last_seen_at: null,
      last_license_validated_at: null
    },
    license: {
      is_active: true,
      is_trial: false,
      is_in_grace: false,
      is_expired: false,
      is_suspended: false,
      can_login: true,
      can_sell: true,
      can_sync: true,
      can_activate_device: true,
      restriction_level: 'none'
    },
    subscription: null,
    features: { pos: true },
    limits: { users: 5 },
    permissions: ['pos.sell'],
    role: { name: 'cashier' },
    loyalty: null,
    branch: null,
    warehouse: null,
    catalog_contract: {
      revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      generated_at: '2026-01-01T00:00:00+00:00',
      valid_until: '2026-01-04T00:00:00+00:00',
      quantity_scale: 3,
      minimum_quantity: '0.001',
      maximum_quantity: '999999.999',
      maximum_unit_price: 1_000_000_000,
      maximum_line_total: 900_000_000_000_000,
      maximum_invoice_total: 900_000_000_000_000,
      mixed_tax_mode_policy: 'single_invoice_mode'
    },
    sync: { snapshot_version: '20260101000000', full_sync_required: true, entities: {} },
    categories: [
      { id: '44444444-4444-4444-8444-444444444444', name: 'Beverages', is_active: true }
    ],
    products: [
      {
        uuid: '55555555-5555-4555-8555-555555555555',
        category_uuid: '44444444-4444-4444-8444-444444444444',
        name: 'Sparkling Water',
        sku: 'WATER-001',
        barcode: '1234567890123',
        description: null,
        status: 'active',
        is_active: true,
        track_stock: true,
        unit: 'each',
        resolved_price: {
          amount: 1250,
          currency: 'EGP',
          source: 'product_base',
          revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          valid_from: '2026-01-01T00:00:00+00:00',
          valid_until: '2026-01-04T00:00:00+00:00'
        },
        resolved_tax: {
          id: '99999999-9999-4999-8999-999999999999',
          mode: 'inclusive',
          rate_basis_points: 1500,
          revision: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
        },
        updated_at: '2026-01-01T00:00:00+00:00'
      }
    ],
    product_barcodes: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        product_uuid: '55555555-5555-4555-8555-555555555555',
        barcode: '1234567890123',
        type: 'ean13',
        is_primary: true,
        is_active: true,
        updated_at: '2026-01-01T00:00:00+00:00'
      }
    ],
    product_prices: [
      {
        id: '77777777-7777-4777-8777-777777777777',
        product_id: 101,
        label: 'Retail',
        amount: 1250,
        currency: 'EGP',
        price_type: 'retail',
        is_active: true,
        starts_at: null,
        ends_at: null,
        updated_at: '2026-01-01T00:00:00+00:00'
      }
    ],
    stock_items: [
      {
        id: '88888888-8888-4888-8888-888888888888',
        product_uuid: '55555555-5555-4555-8555-555555555555',
        warehouse_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        quantity: 10,
        reserved_quantity: 0,
        available_quantity: 10,
        minimum_quantity: null,
        maximum_quantity: null,
        is_active: true,
        updated_at: '2026-01-01T00:00:00+00:00'
      }
    ],
    taxes: [],
    payment_methods: [],
    customers: [],
    ...overrides
  }
}

export function danglingBarcodeCatalogueFixture(): DesktopBootstrapResource {
  return desktopBootstrapFixture({
    product_barcodes: [
      {
        id: '99999999-9999-4999-8999-999999999999',
        product_uuid: '99999999-9999-4999-8999-999999999998',
        barcode: '9999999999999',
        type: 'ean13',
        is_primary: true,
        is_active: true,
        updated_at: '2026-01-01T00:00:00+00:00'
      }
    ]
  })
}
