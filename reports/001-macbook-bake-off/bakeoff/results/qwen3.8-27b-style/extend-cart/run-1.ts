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

function validateCoupon(coupon: Coupon): void {
  if (coupon.kind === "percent") {
    if (!Number.isFinite(coupon.percent)) {
      throw new RangeError("Bad coupon percent");
    }

    if (coupon.percent <= 0) {
      throw new RangeError("Bad coupon percent");
    }

    if (coupon.percent > 100) {
      throw new RangeError("Bad coupon percent");
    }

    if (coupon.maxCents !== undefined) {
      if (!Number.isInteger(coupon.maxCents)) {
        throw new RangeError("Bad coupon maxCents");
      }

      if (coupon.maxCents < 0) {
        throw new RangeError("Bad coupon maxCents");
      }
    }

    return;
  }

  if (coupon.kind === "fixed") {
    if (!Number.isInteger(coupon.cents)) {
      throw new RangeError("Bad coupon cents");
    }

    if (coupon.cents < 1) {
      throw new RangeError("Bad coupon cents");
    }

    return;
  }

  // An unrecognised kind slips past the type at runtime.
  throw new RangeError("Bad coupon kind");
}

function calcDiscount(
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

  // Narrowed to "fixed" after the percent branch.
  return Math.min(coupon.cents, subtotal);
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

  const discount = calcDiscount(coupon, subtotal);

  // Split the discount across taxable and non-taxable lines
  // so tax is levied only on the remaining taxable portion.
  let taxableDiscount = 0;

  if (subtotal > 0) {
    taxableDiscount = Math.round(
      discount * taxableSubtotal / subtotal,
    );
  }

  const tax = Math.round((taxableSubtotal - taxableDiscount) * taxRate);

  return {
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    totalCents: subtotal - discount + tax,
  };
}
