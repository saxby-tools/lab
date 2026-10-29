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

function validateCoupon(coupon: Coupon): void {
  if (coupon.kind === "percent") {
    // Percent must be a meaningful, bounded fraction.
    if (!Number.isFinite(coupon.percent)) {
      throw new RangeError("Bad percent");
    }

    if (coupon.percent <= 0) {
      throw new RangeError("Bad percent");
    }

    if (coupon.percent > MAX_PERCENT) {
      throw new RangeError("Bad percent");
    }

    if (coupon.maxCents !== undefined) {
      if (!Number.isInteger(coupon.maxCents)) {
        throw new RangeError("Bad maxCents");
      }

      if (coupon.maxCents < 0) {
        throw new RangeError("Bad maxCents");
      }
    }

    return;
  }

  if (coupon.kind === "fixed") {
    if (!Number.isInteger(coupon.cents)) {
      throw new RangeError("Bad cents");
    }

    if (coupon.cents < 1) {
      throw new RangeError("Bad cents");
    }

    return;
  }

  // Unreachable at the type level, but guards against
  // untyped runtime callers passing a bogus discriminant.
  throw new RangeError("Unknown coupon kind");
}

function computeDiscount(
  coupon: Coupon | undefined,
  subtotal: number,
): number {
  if (coupon === undefined) {
    return 0;
  }

  if (coupon.kind === "percent") {
    let discount = Math.round(subtotal * coupon.percent / 100);

    if (coupon.maxCents !== undefined) {
      discount = Math.min(discount, coupon.maxCents);
    }

    return Math.min(discount, subtotal);
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

  // Split the discount across taxable and non-taxable lines
  // by their share of the subtotal so tax is charged only
  // on what the buyer actually owes on taxable items.
  let taxableDiscount = 0;

  if (subtotal > 0) {
    taxableDiscount = Math.round(
      (discount * taxableSubtotal) / subtotal,
    );
  }

  const tax = Math.round(
    (taxableSubtotal - taxableDiscount) * taxRate,
  );

  const total = subtotal - discount + tax;

  return {
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    totalCents: total,
  };
}
