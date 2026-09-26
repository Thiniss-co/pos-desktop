import type { ReceiptLocale } from './receiptDocument'

/**
 * Receipt-printing plan — labels main renders directly onto the printed page. Deliberately
 * separate from `src/renderer/src/i18n/locales/*.json` (the renderer's own UI strings): the
 * printed paper is built entirely in main, with no access to the renderer's vue-i18n instance, and
 * these labels never appear in the app's own screens.
 */

export interface ReceiptStrings {
  readonly saleTitle: string
  readonly refundTitle: string
  readonly testTitle: string
  readonly reprintBadge: string
  readonly receiptNumberLabel: string
  readonly serverNumberLabel: string
  readonly cashierLabel: string
  readonly customerLabel: string
  readonly subtotalLabel: string
  readonly discountLabel: string
  readonly invoiceDiscountLabel: string
  readonly taxLabel: string
  readonly grandTotalLabel: string
  readonly paidLabel: string
  readonly changeLabel: string
  readonly refundNumberLabel: string
  readonly refundDateLabel: string
  readonly originalSaleLabel: string
  readonly stockReturnedYes: string
  readonly stockReturnedNo: string
  readonly reasonLabel: string
  readonly unsyncedNotice: string
  readonly historicalNotice: string
  readonly cashLabel: string
  readonly cardLabel: string
  readonly otherPaymentLabel: string
  readonly paymentNotRecordedLabel: string
  readonly originalPriceNotRecordedNotice: string
  readonly footerThankYou: string
}

const EN: ReceiptStrings = {
  saleTitle: 'Receipt',
  refundTitle: 'REFUND RECEIPT',
  testTitle: 'TEST RECEIPT — not a sale',
  reprintBadge: 'Reprint',
  receiptNumberLabel: 'Receipt no.',
  serverNumberLabel: 'Server invoice no.',
  cashierLabel: 'Cashier',
  customerLabel: 'Customer',
  subtotalLabel: 'Subtotal',
  discountLabel: 'Discount',
  invoiceDiscountLabel: 'Order discount',
  taxLabel: 'Tax',
  grandTotalLabel: 'Total',
  paidLabel: 'Paid',
  changeLabel: 'Change',
  refundNumberLabel: 'Refund no.',
  refundDateLabel: 'Refund date',
  originalSaleLabel: 'Original sale',
  stockReturnedYes: 'Stock returned',
  stockReturnedNo: 'Stock not returned',
  reasonLabel: 'Reason',
  unsyncedNotice: 'Local receipt number — not yet confirmed by the server.',
  historicalNotice: 'Store details as of printing. Original issuer details were not recorded.',
  cashLabel: 'Cash',
  cardLabel: 'Card',
  otherPaymentLabel: 'Other payment method',
  paymentNotRecordedLabel: 'Payment method not recorded',
  originalPriceNotRecordedNotice: 'Original unit prices not recorded for this refund.',
  footerThankYou: 'Thank you'
}

const AR: ReceiptStrings = {
  saleTitle: 'إيصال',
  refundTitle: 'إيصال استرداد',
  testTitle: 'إيصال تجريبي — ليس عملية بيع',
  reprintBadge: 'نسخة مكررة',
  receiptNumberLabel: 'رقم الإيصال',
  serverNumberLabel: 'رقم الفاتورة على الخادم',
  cashierLabel: 'الكاشير',
  customerLabel: 'العميل',
  subtotalLabel: 'المجموع الفرعي',
  discountLabel: 'الخصم',
  invoiceDiscountLabel: 'خصم الفاتورة',
  taxLabel: 'الضريبة',
  grandTotalLabel: 'الإجمالي',
  paidLabel: 'المدفوع',
  changeLabel: 'الباقي',
  refundNumberLabel: 'رقم الاسترداد',
  refundDateLabel: 'تاريخ الاسترداد',
  originalSaleLabel: 'الفاتورة الأصلية',
  stockReturnedYes: 'تم إرجاع المخزون',
  stockReturnedNo: 'لم يتم إرجاع المخزون',
  reasonLabel: 'السبب',
  unsyncedNotice: 'رقم محلي — لم يتم تأكيده من الخادم بعد.',
  historicalNotice: 'بيانات المتجر وقت الطباعة. لم تُسجَّل بيانات الجهة المُصدرة الأصلية.',
  cashLabel: 'نقدًا',
  cardLabel: 'بطاقة',
  otherPaymentLabel: 'وسيلة دفع أخرى',
  paymentNotRecordedLabel: 'لم تُسجَّل وسيلة الدفع',
  originalPriceNotRecordedNotice: 'لم يتم تسجيل سعر الوحدة الأصلي لهذا الاسترداد.',
  footerThankYou: 'شكرًا لتعاملكم معنا'
}

export function receiptStrings(locale: ReceiptLocale): ReceiptStrings {
  return locale === 'ar' ? AR : EN
}
