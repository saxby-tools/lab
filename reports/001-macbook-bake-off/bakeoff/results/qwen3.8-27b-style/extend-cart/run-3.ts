const MAX_PERCENT = 100;

export type Coupon =
  | { kind: "percent"; percent: number; maxCents?: number }
  | { kind: "fixed"; cents: number };

export interface CartLine {
  sku: string;
  unitCents: number;
  quantity: number;
  taxable?: boolean;
}

export interface Totals {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}


function checkLine(line: CartLine): void {
  if (!Number.isInteger(line.unitCents) || line.unitCents < 0) {
    throw new RangeError(`Bad unitCents for ${line.sku}`);
  }

  if (!Number.isInteger(line.quantity) || line.quantity < 0) {
    throw new RangeError(`Bad quantity for ${line.sku}`);
  }
}


// Rejects structurally invalid coupons before they can skew the totals.
function validateCoupon(coupon: Coupon): void {
  if (coupon.kind === "percent") {
    const { percent, maxCents } = coupon;

    if (
      !Number.isFinite(percent)
      || percent <= 0
      || percent > MAX_PERCENT
    ) {
      throw new RangeError("Bad percent");
    }

    if (maxCents !== undefined) {
      if (!Number.isInteger(maxCents) || maxCents < 0) {
        throw new RangeError("Bad maxCents");
      }
    }

    return;
  }

  if (coupon.kind === "fixed") {
    const { cents } = coupon;

    if (!Number.isInteger(cents) || cents < 1) {
      throw new RangeError("Bad cents");
    }

    return;
  }

  // Guards against a runtime object whose `kind` is not in the union.
  throw new RangeError("Bad coupon kind");
}


// Returns the discount in integer cents, never exceeding `subtotal`.
function computeDiscount(coupon: Coupon, subtotal: number): number {
  if (coupon.kind === "percent") {
    const raw = Math.round(subtotal * coupon.percent / 100);

    const capped = coupon.maxCents !== undefined
      ? Math.min(raw, coupon.maxCents)
      : raw;

    return Math.min(capped, subtotal);
  }

  return Math.min(coupon.cents, subtotal);
}


export function cartTotals(
  lines: CartLine[],
  taxRate: number,
  coupon?: Coupon,
): Totals {
  if (!Number.isFinite(taxRate) || taxRate < 0) {
    throw new RangeError("Bad taxRate");
  }

  let subtotal = 0;
  let taxableSubtotal = 0;

  for (const line of lines) {
    checkLine(line);

    const lineTotal = line.unitCents * line.quantity;

    subtotal += lineTotal;

    if (line.taxable !== false) {
      taxableSubtotal += lineTotal;
    }
  }

  if (coupon !== undefined) {
    validateCoupon(coupon);
  }

  const discount = coupon !== undefined
    ? computeDiscount(coupon, subtotal)
    : 0;

  // Discount is apportioned across taxable / non-taxable lines
  // in proportion to their share of the subtotal so that tax
  // is levied only on the taxable remainder.
  const taxableDiscount = subtotal === 0
    ? 0
    : Math.round(discount * taxableSubtotal / subtotal);

  const tax =
    Math.round((taxableSubtotal - taxableDiscount) * taxRate);

  return {
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    totalCents: subtotal - discount + tax,
  };
}
