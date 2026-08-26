/**
 * Keeps catalog search keys identical for bootstrap writes, migration backfills, and requests.
 * NFKC intentionally preserves the backend's literal barcode values; barcode matching only trims.
 */
export function normalizeCatalogSearch(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

export function normalizeCatalogBarcode(value: string): string {
  return value.trim()
}

export function catalogPrefixUpperBound(prefix: string): string {
  return `${prefix}\uffff`
}
