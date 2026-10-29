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

function validateCoupon(coupon: Coupon): void {
  if (coupon.kind === "percent") {
    const { percent, maxCents } = coupon;

    if (!Number.isFinite(percent)) {
      throw new RangeError("Percent must be a finite number");
    }

    if (percent <= 0) {
      throw new RangeError("Percent must be greater than 0");
    }

    if (percent > 100) {
      throw new RangeError("Percent must be at most 100");
    }

    if (maxCents === undefined) {
      return;
    }

    if (!Number.isInteger(maxCents)) {
      throw new RangeError("maxCents must be an integer");
    }

    if (maxCents < 0) {
      throw new RangeError("maxCents must be 0 or more");
    }

    return;
  }

  if (coupon.kind === "fixed") {
    if (!Number.isInteger(coupon.cents)) {
      throw new RangeError("Fixed cents must be an integer");
    }

    if (coupon.cents < 1) {
      throw new RangeError("Fixed cents must be 1 or more");
    }

    return;
  }

  throw new RangeError("Unknown coupon kind");
}

function calculateDiscount(subtotal: number, coupon?: Coupon): number {
  if (!coupon) {
    return 0;
  }

  let discount = 0;

  if (coupon.kind === "percent") {
    discount = Math.round(subtotal * coupon.percent / 100);

    if (coupon.maxCents !== undefined) {
      discount = Math.min(discount, coupon.maxCents);
    }
  }

  if (coupon.kind === "fixed") {
    discount = coupon.cents;
  }

  return Math.min(discount, subtotal);
}

function calculateTax(
  taxRate: number,
  taxableSubtotal: number,
  taxableDiscount: number,
): number {
  return Math.round((taxableSubtotal - taxableDiscount) * taxRate);
}

function checkLine(line: CartLine): void {
  if (!Number.isInteger(line.unitCents)) {
    throw new RangeError(`Bad unitCents for ${line.sku}`);
  }

  if (line.unitCents < 0) {
    throw new RangeError(`Bad unitCents for ${line.sku}`);
  }

  if (!Number.isInteger(line.quantity)) {
    throw new RangeError(`Bad quantity for ${line.sku}`);
  }

  if (line.quantity < 0) {
    throw new RangeError(`Bad quantity for ${line.sku}`);
  }
}

export function cartTotals(
  lines: CartLine[],
  taxRate: number,
  coupon?: Coupon,
): Totals {
  if (!Number.isFinite(taxRate)) {
    throw new RangeError("Bad taxRate");
  }

  if (taxRate < 0) {
    throw new RangeError("Bad taxRate");
  }

  if (coupon) {
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

  const discount = calculateDiscount(subtotal, coupon);

  let taxableDiscount = 0;
  if (subtotal > 0) {
    taxableDiscount = Math.round(discount * taxableSubtotal / subtotal);
  }

  const tax = calculateTax(taxRate, taxableSubtotal, taxableDiscount);

  return {
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    totalCents: subtotal - discount + tax,
  };
}
