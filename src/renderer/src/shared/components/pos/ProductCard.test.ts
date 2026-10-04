// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ProductCard from './ProductCard.vue'
import type { DisplayProduct } from './types'

function product(overrides: Partial<DisplayProduct> = {}): DisplayProduct {
  return {
    id: 'p1',
    name: 'Water Bottle',
    sku: 'WATER-500',
    price: '$1.00',
    monogram: 'WB',
    stock: 'recorded',
    ...overrides
  }
}

describe('ProductCard — Rev 4 §4.3', () => {
  it('a zero or missing warehouse figure never dims or disables the card', () => {
    const wrapper = mount(ProductCard, {
      props: { product: product({ stock: 'recorded' }), stockLabel: 'Recorded 0' }
    })
    expect(wrapper.find('button').attributes('disabled')).toBeUndefined()
    expect(wrapper.html()).not.toContain('opacity-60')
    expect(wrapper.find('button').classes()).toContain('text-ink')
    wrapper.unmount()
  })

  it('only a non-stock reason (no open shift) disables it, and even then it is not dimmed', () => {
    const wrapper = mount(ProductCard, {
      props: { product: product({ stock: 'in-stock' }), stockLabel: 'Warehouse 50', disabled: true }
    })
    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
    expect(wrapper.html()).not.toContain('opacity-60')
    wrapper.unmount()
  })

  it('shows the verified image when there is one, and falls back to the monogram when it fails to draw (P8)', async () => {
    const wrapper = mount(ProductCard, {
      props: {
        product: product({ imageUrl: 'data:image/webp;base64,UklGRg==' }),
        stockLabel: 'Recorded 0'
      }
    })
    expect(wrapper.find('[data-testid="product-card-image"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('WB')

    await wrapper.find('[data-testid="product-card-image"]').trigger('error')
    expect(wrapper.find('[data-testid="product-card-image"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('WB')
    wrapper.unmount()
  })

  it('without an image keeps the monogram band', () => {
    const wrapper = mount(ProductCard, { props: { product: product(), stockLabel: 'Recorded 0' } })
    expect(wrapper.find('[data-testid="product-card-image"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('WB')
    wrapper.unmount()
  })
})
