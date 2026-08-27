import { equal } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { formatMinorCurrency } from '../../../src/shared/money/minorUnits'
import { databaseTest } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'

function expectedCurrencyParts(amount: number, exponent: number): string {
  const scale = 10n ** BigInt(exponent)
  const value = BigInt(amount)
  const fraction = exponent === 0 ? '' : String(value % scale).padStart(exponent, '0')

  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency: 'EGP',
    currencyDisplay: 'symbol',
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
    numberingSystem: 'latn'
  })
    .formatToParts(value / scale)
    .map((part) => (part.type === 'fraction' ? fraction : part.value))
    .join('')
}

databaseTest(
  'Electron formats maximum minor-unit amounts without a 32-bit conversion',
  (sandbox) => {
    const database = openTestDatabase(sandbox)

    for (const amount of [0, 2_147_483_647, 2_147_483_648, 900_000_000_000_000]) {
      const result = formatMinorCurrency(amount, 'en', 'EGP', 2)
      equal(result.ok, true)
      if (result.ok) {
        equal(result.value, expectedCurrencyParts(amount, 2))
      }
    }

    closeDatabase(database)
  }
)
