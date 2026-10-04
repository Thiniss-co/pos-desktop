# POS shortcut inventory and touch equivalents (Stage 5)

Source: `usePosShortcuts.ts` (function keys), `scanInputRouter.ts` (payment / done mode), `PosPage.vue`.
In touch mode every control below is at least 44×44 (measured by `qc5touch`, 16 combinations).

| Key | Action | Visible control in touch mode |
|---|---|---|
| F1 | Help | Touch bar → **Help** |
| F2 | Focus product search | The search field itself (tap) |
| F3 | Focus scan entry | The scan field itself (tap); focus also returns there after every overlay |
| F4 | Hold sale | Quick-action tile **Hold** |
| F6 | Recall held sale | Quick-action tile **Recall** |
| F7 | Choose customer | **Choose customer** button on the cart |
| F8 | Invoice discount | **Add discount** in the cart totals (the discount dialog gets the on-screen keypad) |
| F9 | Pay | Touch bar → **Pay**, and the **Pay** button under the cart |
| Shift+F9 | Exact cash | Touch bar → **Exact cash** |
| F10 | Return / Refund | Quick-action tile **Return / Refund** |
| Enter (payment) | Primary action (complete) | The panel's primary button |
| Ctrl+P (done) | Print receipt | The panel's **Print receipt** button |
| Esc | Close the payment panel / dialog | The panel or dialog **Close** button |
| `3*code` | Quantity before a scanned code | Next-scan multiplier buttons (×2 ×3 ×5 ×10), or tap the line quantity → keypad |
| Line −/+ | Change a line quantity | − / + buttons (48px), or tap the quantity → **Set quantity** keypad |
| Tender typing | Cash received | On-screen keypad under the amount field |

Scanner input and every function key keep working unchanged in touch mode.
