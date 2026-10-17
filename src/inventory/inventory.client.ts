import { Injectable } from '@nestjs/common';

export interface Quote {
  listing_id: string;
  available: boolean;
  nights: { date: string; available: boolean; price: number }[];
  total: number;
  nightly_avg: number | null;
  currency: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isQuote(value: unknown): value is Quote {
  if (!isRecord(value) || typeof value.listing_id !== 'string' || typeof value.available !== 'boolean' ||
      typeof value.total !== 'number' || !(typeof value.nightly_avg === 'number' || value.nightly_avg === null) ||
      typeof value.currency !== 'string' || !Array.isArray(value.nights)) return false;
  return value.nights.every((night: unknown) => isRecord(night) && typeof night.date === 'string' &&
    typeof night.available === 'boolean' && typeof night.price === 'number');
}

/** Hearthly's live availability and prices (tools/inventory-dev.mjs locally; INVENTORY_URL when graded). */
@Injectable()
export class InventoryClient {
  private readonly base = (process.env.INVENTORY_URL ?? 'http://localhost:4010').replace(/\/$/, '');

  /** At most 50 ids per call. */
  async quotes(ids: string[], checkIn: string, checkOut: string): Promise<Quote[]> {
    const url = `${this.base}/v1/availability?ids=${ids.join(',')}&check_in=${checkIn}&check_out=${checkOut}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`inventory ${res.status}: ${await res.text()}`);
    const payload: unknown = await res.json();
    if (!isRecord(payload) || !Array.isArray(payload.results) || !payload.results.every(isQuote)) {
      throw new Error('inventory returned an invalid quote response');
    }
    return payload.results;
  }
}
