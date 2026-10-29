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

function validateCoupon(coupon?: Coupon): void {
  if (!coupon) return;
  
  if (coupon.kind === "percent") {
    if (!Number.isFinite(coupon.percent) || coupon.percent <= 0 || coupon.percent > 100) {
      throw new RangeError("Invalid percent coupon: percent must be a finite number greater than 0 and at most 100");
    }
    if (coupon.maxCents !== undefined) {
      if (!Number.isInteger(coupon.maxCents) || coupon.maxCents < 0) {
        throw new RangeError("Invalid percent coupon: maxCents must be an integer of 0 or more");
      }
    }
  } else if (coupon.kind === "fixed") {
    if (!Number.isInteger(coupon.cents) || coupon.cents <= 0) {
      throw new RangeError("Invalid fixed coupon: cents must be an integer of 1 or more");
    }
  } else {
    throw new RangeError("Invalid coupon: unknown kind");
  }
}

export function cartTotals(lines: CartLine[], taxRate: number, coupon?: Coupon): Totals {
  // Validate coupon first
  validateCoupon(coupon);
  
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

  // Calculate discount
  let discount = 0;
  
  if (coupon) {
    if (coupon.kind === "percent") {
      discount = Math.round(subtotal * coupon.percent / 100);
      if (coupon.maxCents !== undefined) {
        discount = Math.min(discount, coupon.maxCents);
      }
    } else if (coupon.kind === "fixed") {
      discount = coupon.cents;
    }
    
    // Ensure discount is never more than subtotal
    discount = Math.min(discount, subtotal);
  }
  
  // Calculate discount allocation for tax purposes
  let taxableDiscount = 0;
  if (subtotal > 0) {
    taxableDiscount = Math.round(discount * taxableSubtotal / subtotal);
  }
  
  const tax = Math.round((taxableSubtotal - taxableDiscount) * taxRate);

  const total = subtotal - discount + tax;

  return {
    subtotalCents: subtotal,
    taxCents: tax,
    totalCents: total,
    discountCents: discount,
  };
}
