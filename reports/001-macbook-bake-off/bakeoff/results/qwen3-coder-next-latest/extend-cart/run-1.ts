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
  taxCents: number;
  totalCents: number;
  discountCents: number;
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
    if (!Number.isFinite(coupon.percent) || coupon.percent <= 0 || coupon.percent > 100) {
      throw new RangeError("Invalid percent coupon: percent must be a finite number > 0 and <= 100");
    }
    
    if (coupon.maxCents !== undefined) {
      if (!Number.isInteger(coupon.maxCents) || coupon.maxCents < 0) {
        throw new RangeError("Invalid percent coupon: maxCents must be an integer >= 0");
      }
    }
  } else if (coupon.kind === "fixed") {
    if (!Number.isInteger(coupon.cents) || coupon.cents < 1) {
      throw new RangeError("Invalid fixed coupon: cents must be an integer >= 1");
    }
  } else {
    throw new RangeError("Invalid coupon kind");
  }
}

export function cartTotals(lines: CartLine[], taxRate: number, coupon?: Coupon): Totals {
  if (!Number.isFinite(taxRate) || taxRate < 0) {
    throw new RangeError("Bad taxRate");
  }

  // Validate coupon if provided
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

  // Calculate discount
  let discountCents = 0;
  if (coupon) {
    if (coupon.kind === "percent") {
      discountCents = Math.round(subtotal * coupon.percent / 100);
      if (coupon.maxCents !== undefined) {
        discountCents = Math.min(discountCents, coupon.maxCents);
      }
    } else if (coupon.kind === "fixed") {
      discountCents = coupon.cents;
    }
  }

  // Ensure discount doesn't exceed subtotal
  discountCents = Math.min(discountCents, subtotal);

  // Calculate taxable discount proportionally
  let taxableDiscount = 0;
  if (subtotal > 0) {
    taxableDiscount = Math.round(discountCents * taxableSubtotal / subtotal);
  }

  // Calculate tax on the taxable portion after discount
  const tax = Math.round((taxableSubtotal - taxableDiscount) * taxRate);

  // Calculate total
  const total = subtotal - discountCents + tax;

  return {
    subtotalCents: subtotal,
    taxCents: tax,
    totalCents: total,
    discountCents: discountCents,
  };
}
