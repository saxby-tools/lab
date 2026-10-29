export interface CartLine {
  sku: string;
  unitCents: number;
  quantity: number;
  taxable?: boolean;
}

export interface Totals {
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
}

export type Coupon =
  | { kind: "percent"; percent: number; maxCents?: number }
  | { kind: "fixed"; cents: number };

function checkLine(line: CartLine): void {
  if (!Number.isInteger(line.unitCents) || line.unitCents < 0) {
    throw new RangeError(`Bad unitCents for ${line.sku}`);
  }

  if (!Number.isInteger(line.quantity) || line.quantity < 0) {
    throw new RangeError(`Bad quantity for ${line.sku}`);
  }
}

function validateCoupon(coupon: Coupon): void {
  if (coupon.kind === "percent") {
    if (
      !Number.isFinite(coupon.percent) ||
      coupon.percent <= 0 ||
      coupon.percent > 100
    ) {
      throw new RangeError("Bad percent in coupon");
    }

    if (
      coupon.maxCents !== undefined &&
      (!Number.isInteger(coupon.maxCents) || coupon.maxCents < 0)
    ) {
      throw new RangeError("Bad maxCents in coupon");
    }
  } else if (coupon.kind === "fixed") {
    if (!Number.isInteger(coupon.cents) || coupon.cents < 1) {
      throw new RangeError("Bad cents in fixed coupon");
    }
  } else {
    throw new RangeError("Unknown coupon kind");
  }
}

function computeDiscount(
  coupon: Coupon | undefined,
  subtotal: number,
): number {
  if (!coupon) return 0;

  let discount: number;

  if (coupon.kind === "percent") {
    discount = Math.round(subtotal * coupon.percent / 100);
    if (coupon.maxCents !== undefined) {
      discount = Math.min(discount, coupon.maxCents);
    }
  } else {
    discount = coupon.cents;
  }

  return Math.min(discount, subtotal);
}

export function cartTotals(
  lines: CartLine[],
  taxRate: number,
  coupon?: Coupon,
): Totals {
  if (!Number.isFinite(taxRate) || taxRate < 0) {
    throw new RangeError("Bad taxRate");
  }

  if (coupon !== undefined) {
    validateCoupon(coupon);
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

  const discount = computeDiscount(coupon, subtotal);

  let taxableDiscount = 0;
  if (subtotal > 0) {
    taxableDiscount = Math.round(discount * taxableSubtotal / subtotal);
  }

  const postTaxable = taxableSubtotal - taxableDiscount;
  const tax = Math.round(postTaxable * taxRate);

  const total = subtotal - discount + tax;

  return {
    subtotalCents: subtotal,
    taxCents: tax,
    discountCents: discount,
    totalCents: total,
  };
}
