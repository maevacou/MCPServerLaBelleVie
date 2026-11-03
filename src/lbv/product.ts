/**
 * Shared parser for the nested `product` object that both
 * `/api/orders/{id}/products` and `/favorites-lists/{id}/products` embed in
 * their rows (identical shape). It owns the availability rule so orders and
 * favorites always agree on what "available" means.
 */

export interface ProductDetail {
  /** Current catalogue price in euros, or null when unknown. */
  price: number | null;
  /** Selling unit as displayed on the site ("La pièce", "Le kg"), or null. */
  unit: string | null;
  /**
   * true/false when the payload carries stock information; null when it does
   * not (bare rows, HTML pages without an availability marker).
   */
  available: boolean | null;
  /** Product thumbnail (https URL on the site's CDN), or null when the payload has none. */
  picture: string | null;
}

/** First https thumbnail URL the product payload carries. */
export function pictureOf(p: Record<string, unknown>): string | null {
  for (const k of ['picture_thumbnail_url', 'picture_thumbnail_big_url', 'picture']) {
    const v = p[k];
    if (typeof v === 'string' && /^https:\/\//.test(v)) return v;
  }
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * `null` is the site's own "rupture" marker: the row's product has been
 * withdrawn from the catalogue and cannot be ordered. Anything that is not an
 * object carries no stock information at all.
 */
export function parseProductDetail(product: unknown): ProductDetail {
  if (product === null) return { price: null, unit: null, available: false, picture: null };
  if (typeof product !== 'object') return { price: null, unit: null, available: null, picture: null };
  const p = product as Record<string, unknown>;

  const label = p.label_unit_notation_listing;
  const unitRaw =
    label && typeof label === 'object'
      ? (label as Record<string, unknown>).formatted_selling_unit
      : undefined;
  const unit = typeof unitRaw === 'string' && unitRaw.trim() !== '' ? unitRaw.trim() : null;

  let available: boolean | null = null;
  if ('disponibility' in p) {
    const inStock = p.unlimited_stocks === true || (num(p.stock_quantity) ?? 0) > 0;
    available =
      p.disponibility === 'order' &&
      inStock &&
      p.can_not_be_added_to_an_order_by_the_client !== true;
  }

  return { price: num(p.price), unit, available, picture: pictureOf(p) };
}
