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
  if (
    !Number.isInteger(line.unitCents) || line.unitCents < 0
  ) {
    throw new RangeError(`Bad unitCents for ${line.sku}`);
  }

  if (
    !Number.isInteger(line.quantity) || line.quantity < 0
  ) {
    throw new RangeError(`Bad quantity for ${line.sku}`);
  }
}

function checkCoupon(coupon: Coupon): void {
  if (coupon.kind === "percent") {
    const { percent, maxCents } = coupon;
    if (
      !(
        Number.isFinite(percent) &&
        percent > 0 &&
        percent <= 100
      )
    ) {
      throw new RangeError("Bad percent for coupon");
    }
    if (
      maxCents !== undefined &&
      !(
        Number.isInteger(maxCents) &&
        maxCents >= 0
      )
    ) {
      throw new RangeError("Bad maxCents for coupon");
    }
  } else if (coupon.kind === "fixed") {
    const { cents } = coupon;
    if (!Number.isInteger(cents) || cents < 1) {
      throw new RangeError("Bad cents for coupon");
    }
  } else {
    throw new RangeError("Unknown coupon kind");
  }
}

function calculateDiscount(
  coupon: Coupon,
  subtotal: number,
): number {
  checkCoupon(coupon);

  let discount: number;

  if (coupon.kind === "percent") {
    discount = Math.round(
      (subtotal * coupon.percent) / 100,
    );
    if (
      coupon.maxCents !== undefined &&
      discount > coupon.maxCents
    ) {
      discount = coupon.maxCents;
    }
  } else {
    discount = coupon.cents;
  }

  if (discount > subtotal) {
    discount = subtotal;
  }

  return discount;
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

  let discount = 0;

  if (coupon !== undefined) {
    discount = calculateDiscount(coupon, subtotal);

    if (subtotal === 0) {
      discount = 0;
    }
  }

  const taxableDiscount = subtotal === 0
    ? 0
    : Math.round(
      (discount * taxableSubtotal) / subtotal,
    );

  const taxableAfterDiscount = taxableSubtotal - taxableDiscount;

  const tax = Math.round(taxableAfterDiscount * taxRate);

  const total = subtotal - discount + tax;

  return {
    subtotalCents: subtotal,
    taxCents: tax,
    totalCents: total,
    discountCents: discount,
  };
}
