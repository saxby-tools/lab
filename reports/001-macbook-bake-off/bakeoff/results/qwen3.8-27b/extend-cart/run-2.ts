export interface CartLine {
  sku: string;
  unitCents: number;
  quantity: number;
  taxable?: boolean;
}

export type Coupon =
  | { kind: "percent"; percent: number; maxCents?: number }
  | { kind: "fixed"; cents: number };

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

function validateCoupon(coupon: Coupon): void {
  if (coupon.kind === "percent") {
    const { percent, maxCents } = coupon;
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      throw new RangeError("Invalid percent coupon");
    }
    if (maxCents !== undefined && (!Number.isInteger(maxCents) || maxCents < 0)) {
      throw new RangeError("Invalid maxCents");
    }
  } else if (coupon.kind === "fixed") {
    const { cents } = coupon;
    if (!Number.isInteger(cents) || cents < 1) {
      throw new RangeError("Invalid fixed coupon");
    }
  } else {
    throw new RangeError("Unknown coupon kind");
  }
}

function computeDiscount(coupon: Coupon | undefined, subtotal: number): number {
  if (coupon === undefined) return 0;

  let discount: number;

  if (coupon.kind === "percent") {
    discount = Math.round((subtotal * coupon.percent) / 100);
    if (coupon.maxCents !== undefined) {
      discount = Math.min(discount, coupon.maxCents);
    }
  } else {
    discount = coupon.cents;
  }

  // Discount is never more than the subtotal
  if (discount > subtotal) {
    discount = subtotal;
  }

  return discount;
}

export function cartTotals(lines: CartLine[], taxRate: number, coupon?: Coupon): Totals {
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

  let tax: number;
  if (subtotal === 0) {
    tax = 0;
  } else {
    const taxableDiscount = Math.round((discount * taxableSubtotal) / subtotal);
    tax = Math.round((taxableSubtotal - taxableDiscount) * taxRate);
  }

  const total = subtotal - discount + tax;

  return {
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    totalCents: total,
  };
}
