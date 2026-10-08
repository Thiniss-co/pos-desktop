/**
 * Real touch input for journeys: CDP touch events (`Input.dispatchTouchEvent`), never a mouse click or
 * a keyboard shortcut. Shared by `qc5touch` and `qc5touchprice`.
 */

/** Enables touch emulation for the page and returns the CDP session taps go through. */
export async function touchSession(page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  return cdp
}

/** One real touch tap at the centre of the element (fails if it is not visible). */
export async function tap(cdp, locator) {
  await locator.waitFor({ state: 'visible' })
  await locator.scrollIntoViewIfNeeded()
  // Wait for a settled layout (a resize or theme change can still be moving things).
  let box = await locator.boundingBox()
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await locator.page().waitForTimeout(100)
    const next = await locator.boundingBox()
    if (box && next && Math.abs(next.x - box.x) < 0.5 && Math.abs(next.y - box.y) < 0.5) break
    box = next
  }
  if (!box) throw new Error('tap: element has no box')
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  // The tap must land on the target itself: report what is really under the point otherwise.
  const hit = await locator.evaluate(
    (element, [x, y]) => {
      const under = document.elementFromPoint(x, y)
      return under === element || element.contains(under)
        ? null
        : { under: under?.outerHTML.slice(0, 160) ?? null, target: element.outerHTML.slice(0, 160) }
    },
    [point.x, point.y]
  )
  if (hit) throw new Error(`tap: the point is covered: ${JSON.stringify(hit)}`)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await locator.page().waitForTimeout(150)
}
