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
  switch (coupon.kind) {
    case "percent": {
      const { percent, maxCents } = coupon;
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
        throw new RangeError("Invalid percent coupon");
      }
      if (maxCents !== undefined && (!Number.isInteger(maxCents) || maxCents < 0)) {
        throw new RangeError("Invalid maxCents");
      }
      break;
    }
    case "fixed": {
      const { cents } = coupon;
      if (!Number.isInteger(cents) || cents < 1) {
        throw new RangeError("Invalid fixed coupon");
      }
      break;
    }
    default:
      throw new RangeError("Invalid coupon kind");
  }
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

  // --- Discount ---
  let discount = 0;
  if (coupon !== undefined) {
    if (coupon.kind === "percent") {
      discount = Math.round((subtotal * coupon.percent) / 100);
      if (coupon.maxCents !== undefined) {
        discount = Math.min(discount, coupon.maxCents);
      }
    } else {
      discount = coupon.cents;
    }
    // Discount can never exceed the subtotal
    discount = Math.min(discount, subtotal);
  }

  // --- Tax (applied to the taxable remainder after discount) ---
  let taxableDiscount = 0;
  if (subtotal > 0) {
    taxableDiscount = Math.round((discount * taxableSubtotal) / subtotal);
  }
  const tax = Math.round((taxableSubtotal - taxableDiscount) * taxRate);

  // --- Total ---
  const total = subtotal - discount + tax;

  return {
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    totalCents: total,
  };
}
