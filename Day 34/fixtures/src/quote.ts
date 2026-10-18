import type { Item } from "./items.js";

export interface QuoteOptions {
  currency?: "USD" | "EUR";
  discountCode?: string;
}

export interface QuoteResult {
  subtotal: number;
  discount: number;
  total: number;
  currency: "USD" | "EUR";
}

const DISCOUNTS: Record<string, number> = {
  SAVE10: 0.1,
};

export function quote(
  item: Item,
  qty: number,
  options?: QuoteOptions,
): QuoteResult {
  const currency = options?.currency ?? "USD";
  const subtotal = item.unitPrice * qty;
  const rate = options?.discountCode
    ? DISCOUNTS[options.discountCode] ?? 0
    : 0;
  const discount = subtotal * rate;
  const total = subtotal - discount;
  return { subtotal, discount, total, currency };
}
