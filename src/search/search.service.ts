import { BadRequestException, Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CatalogService, Listing, Place } from '../catalog/catalog.service';
import { InventoryClient, Quote } from '../inventory/inventory.client';

export interface SearchResult {
  listing_id: string;
  title: string;
  nightly_avg: number | null;
  total: number | null;
  currency: string;
  why: string;
}

type DateRange = { checkIn: string; checkOut: string; nights: number; source: string };
type PriceRule = { amount: number; mode: 'nightly' | 'total'; currency: string | null };
type ParsedQuery = {
  place: Place | null;
  near: boolean;
  guests: number | null;
  pets: boolean;
  dateRange: DateRange;
  price: PriceRule | null;
  semanticText: string;
};

const DAY_MS = 86_400_000;
const CONCEPTS: Record<string, string[]> = JSON.parse(readFileSync(join(process.cwd(), 'tools', 'concepts.json'), 'utf8'));
const CONCEPT_KEYS = Object.keys(CONCEPTS);
const TOKEN_TO_CONCEPTS = new Map<string, number[]>();
CONCEPT_KEYS.forEach((key, i) => {
  for (const word of CONCEPTS[key] ?? []) TOKEN_TO_CONCEPTS.set(word, [...(TOKEN_TO_CONCEPTS.get(word) ?? []), i]);
});
const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8,
  october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};
const PLACE_RADIUS_KM = 40;
const TYPE_GROUPS: Record<string, string[]> = {
  cabin: ['cabin', 'a-frame', 'chalet', 'lodge'],
  lodge: ['lodge'],
  house: ['house'],
  cottage: ['cottage', 'house'],
  apartment: ['apartment', 'serviced apartment', 'studio'],
  farmhouse: ['farmhouse'],
  treehouse: ['treehouse'],
  villa: ['villa'],
};

function parseYmd(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}
function ymd(date: Date): string { return date.toISOString().slice(0, 10); }
function addDays(date: Date, days: number): Date { return new Date(date.getTime() + days * DAY_MS); }
function startOfDay(value: string): Date {
  const parsed = parseYmd(value);
  if (!parsed) throw new BadRequestException('x-now must be a valid YYYY-MM-DD date.');
  return parsed;
}
function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (n: number) => n * Math.PI / 180;
  const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function findPlace(q: string, places: Place[]): Place | null {
  const candidates = places.flatMap((p) => [p.name, p.id.replace(/-/g, ' '), ...p.aliases].map((name) => ({ p, name })));
  return candidates.sort((a, b) => b.name.length - a.name.length).find(({ name }) => new RegExp(`(?:^|\\b)${escapeRegExp(name.toLowerCase())}(?:\\b|$)`, 'i').test(q))?.p ?? null;
}
function findPlaceScope(q: string, places: Place[]): { places: Place[]; label: string } {
  const specific = findPlace(q, places);
  if (specific) return { places: [specific], label: specific.name };
  const regions = [...new Set(places.map((place) => place.region))].sort((a, b) => b.length - a.length);
  const region = regions.find((name) => new RegExp(`(?:^|\\b)${escapeRegExp(name.toLowerCase())}(?:\\b|$)`, 'i').test(q));
  return region ? { places: places.filter((place) => place.region === region), label: region } : { places: [], label: '' };
}
function parseDateRange(q: string, nowText: string): DateRange {
  const now = startOfDay(nowText);
  const lower = q.toLowerCase();
  const explicit = lower.match(/\b(20\d{2}-\d{2}-\d{2})\s*(?:to|through|until|–|-)\s*(20\d{2}-\d{2}-\d{2})\b/);
  if (explicit) {
    const [checkIn, checkOut] = [explicit[1], explicit[2]];
    const a = parseYmd(checkIn); const b = parseYmd(checkOut);
    if (!a || !b || b <= a || (b.getTime() - a.getTime()) / DAY_MS > 30) throw new BadRequestException('Dates must be valid and span 1 to 30 nights.');
    return { checkIn, checkOut, nights: (b.getTime() - a.getTime()) / DAY_MS, source: 'explicit date range' };
  }
  const monthRange = lower.match(/\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|through|–|-)\s*(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?\b/);
  if (monthRange) {
    const month = MONTHS[monthRange[1]];
    let year = monthRange[4] ? Number(monthRange[4]) : now.getUTCFullYear();
    if (!monthRange[4] && month < now.getUTCMonth()) year += 1;
    const a = new Date(Date.UTC(year, month, Number(monthRange[2])));
    const b = new Date(Date.UTC(year, month, Number(monthRange[3])));
    if (a.getUTCMonth() !== month || b.getUTCMonth() !== month || b <= a || (b.getTime() - a.getTime()) / DAY_MS > 30) throw new BadRequestException('Invalid requested date range.');
    return { checkIn: ymd(a), checkOut: ymd(b), nights: (b.getTime() - a.getTime()) / DAY_MS, source: 'named date range' };
  }
  const named = lower.match(/\b(first|second|third|last)?\s*(?:weekend\s+of\s+)?(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\s*(?:\d{1,2}(?:st|nd|rd|th)?\s*)?(20\d{2})?\b/);
  if (named) {
    const month = MONTHS[named[2]];
    let year = named[3] ? Number(named[3]) : now.getUTCFullYear();
    if (!named[3] && month < now.getUTCMonth()) year += 1;
    const phraseHasWeekend = /weekend/.test(lower);
    let checkInDate: Date;
    if (phraseHasWeekend || named[1]) {
      const first = new Date(Date.UTC(year, month, 1));
      const firstFriday = new Date(first.getTime() + ((5 - first.getUTCDay() + 7) % 7) * DAY_MS);
      const ordinal = named[1] === 'second' ? 1 : named[1] === 'third' ? 2 : named[1] === 'last' ? Math.floor((new Date(Date.UTC(year, month + 1, 0)).getUTCDate() - firstFriday.getUTCDate()) / 7) : 0;
      checkInDate = new Date(firstFriday.getTime() + ordinal * 7 * DAY_MS);
      if (checkInDate.getUTCMonth() !== month) throw new BadRequestException('That month has no requested weekend.');
    } else {
      const dayMatch = lower.match(new RegExp(`\\b${named[2]}\\s+(\\d{1,2})(?:st|nd|rd|th)?`));
      checkInDate = new Date(Date.UTC(year, month, dayMatch ? Number(dayMatch[1]) : 1));
      if (checkInDate.getUTCMonth() !== month || (dayMatch && checkInDate.getUTCDate() !== Number(dayMatch[1]))) throw new BadRequestException('Invalid requested date.');
    }
    const nights = phraseHasWeekend || named[1] ? 2 : 1;
    return { checkIn: ymd(checkInDate), checkOut: ymd(addDays(checkInDate, nights)), nights, source: phraseHasWeekend || named[1] ? 'named weekend' : 'named date' };
  }
  const weekend = lower.match(/\b(this|next|coming)\s+weekend\b|\bweekend\b/);
  if (weekend) {
    const dow = now.getUTCDay();
    let daysUntilFriday = (5 - dow + 7) % 7;
    if (daysUntilFriday === 0 && /next/.test(weekend[0])) daysUntilFriday = 7;
    if (/next/.test(weekend[0]) && daysUntilFriday < 7) daysUntilFriday += 7;
    if (!/next/.test(weekend[0]) && dow === 6) {
      return { checkIn: ymd(now), checkOut: ymd(addDays(now, 1)), nights: 1, source: weekend[0] };
    }
    const checkInDate = addDays(now, daysUntilFriday);
    return { checkIn: ymd(checkInDate), checkOut: ymd(addDays(checkInDate, 2)), nights: 2, source: weekend[0] };
  }
  const relative = lower.match(/\b(in|for)\s+(\d{1,2})\s+nights?\b/);
  if (relative) {
    const nights = Number(relative[2]);
    if (nights < 1 || nights > 30) throw new BadRequestException('Stay length must be from 1 to 30 nights.');
    const start = /tonight|today/.test(lower) ? now : addDays(now, 7);
    return { checkIn: ymd(start), checkOut: ymd(addDays(start, nights)), nights, source: `${nights}-night stay, default start in 7 days` };
  }
  const tonight = /\btonight\b/.test(lower);
  const tomorrow = /\btomorrow\b/.test(lower);
  const start = tonight ? now : tomorrow ? addDays(now, 1) : addDays(now, 7);
  return { checkIn: ymd(start), checkOut: ymd(addDays(start, 1)), nights: 1, source: tonight ? 'tonight' : tomorrow ? 'tomorrow' : 'default one night starting in 7 days' };
}
function parsePrice(q: string): PriceRule | null {
  const m = q.match(/(?:under|below|less than|maximum|max|up to|at most|within|budget(?: of)?|no more than)\s*(₦|NGN\s*|GH₵|GHS\s*|\$|USD\s*)?([\d,]+(?:\.\d{1,2})?)\s*(₦|NGN|GH₵|GHS|\$|USD)?/i);
  if (!m) return null;
  const amount = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(amount)) return null;
  const currencyText = (m[1] || m[3] || '').trim().toUpperCase();
  const currency = currencyText === '₦' || currencyText.startsWith('NGN') ? 'NGN' : currencyText === 'GH₵' || currencyText.startsWith('GHS') ? 'GHS' : currencyText === '$' || currencyText.startsWith('USD') ? 'USD' : null;
  const mode = /per\s+night|nightly|\/night/i.test(q) ? 'nightly' : /total|all\s+nights|for\s+the\s+stay/i.test(q) ? 'total' : 'nightly';
  return { amount, mode, currency };
}
function parseGuests(q: string): number | null {
  const m = q.match(/\b(?:for|sleeps?|sleeping|party of|group of)\s+(\d{1,2})\b/i) ?? q.match(/\b(\d{1,2})\s+(?:guests?|people|persons?|of us|adults?)\b/i);
  if (m) return Math.min(30, Number(m[1]));
  const words: Record<string, number> = { one: 1, two: 2, couple: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const wordMatch = q.match(/\b(?:for|party of|group of)\s+(one|two|couple|three|four|five|six|seven|eight|nine|ten)\b/i) ?? q.match(/\b(one|two|couple|three|four|five|six|seven|eight|nine|ten)\s+(?:of us|guests?|people|persons?|adults?)\b/i);
  if (wordMatch) return words[wordMatch[1].toLowerCase()];
  return null;
}
function embed(text: string): number[] {
  const vector: number[] = Array.from({ length: CONCEPT_KEYS.length }, () => 0);
  for (const token of text.toLowerCase().split(/[^a-z0-9-]+/)) {
    for (const i of TOKEN_TO_CONCEPTS.get(token) ?? TOKEN_TO_CONCEPTS.get(token.replace(/s$/, '')) ?? []) vector[i] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((n) => n / norm);
}
function cosine(a: number[], b: number[]): number { return a.reduce((sum, n, i) => sum + n * b[i], 0); }
function semanticScore(queryVector: number[], queryText: string, listing: Listing, place: Place | null): number {
  const text = `${listing.title} ${listing.description} ${listing.type} ${listing.amenities.join(' ')}`;
  const listingVector = embed(text);
  const ignored = new Set(['near', 'nearby', 'around', 'close', 'to', 'in', 'for', 'of', 'us', 'with', 'and', 'a', 'an', 'the', 'this', 'next', 'coming', 'weekend', 'tonight', 'tomorrow', 'under', 'below', 'less', 'than', 'maximum', 'max', 'up', 'at', 'most', 'within', 'budget', 'no', 'more', 'per', 'night', 'nightly', 'total', 'nights', 'stay', 'people', 'guests', 'persons', 'adults', 'four', 'three', 'two', 'six', 'five', 'couple', 'party', 'group']);
  for (const month of Object.keys(MONTHS)) ignored.add(month);
  if (place) for (const part of `${place.name} ${place.id.replace(/-/g, ' ')} ${place.aliases.join(' ')}`.toLowerCase().split(/[^a-z0-9]+/)) ignored.add(part);
  const terms = queryText.toLowerCase().split(/[^a-z0-9-]+/).filter((word) => word.length > 2 && !ignored.has(word) && !/^\d+$/.test(word));
  const titleWords = new Set(listing.title.toLowerCase().split(/[^a-z0-9-]+/));
  const bodyWords = new Set(`${listing.description} ${listing.type} ${listing.amenities.join(' ')}`.toLowerCase().split(/[^a-z0-9-]+/));
  const lexical = terms.reduce((score, term) => {
    const singular = term.replace(/s$/, '');
    const titleMatch = titleWords.has(term) || titleWords.has(singular) || (term.length > 4 && [...titleWords].some((word) => word.startsWith(singular)));
    const bodyMatch = bodyWords.has(term) || bodyWords.has(singular) || (term.length > 4 && [...bodyWords].some((word) => word.startsWith(singular)));
    return score + (titleMatch ? 0.09 : 0) + (!titleMatch && bodyMatch ? 0.035 : 0);
  }, 0);
  const typePreference = Object.entries(TYPE_GROUPS).reduce((best, [term, group]) => {
    if (!new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(queryText)) return best;
    return Math.max(best, group.includes(listing.type) ? (listing.type === term ? 0.42 : 0.22) : 0);
  }, 0);
  return cosine(queryVector, listingVector) + lexical + typePreference;
}
function formatWhy(listing: Listing, placeName: string | null, matchedTerms: string[]): string {
  const pieces = [listing.type.replace(/\b\w/g, (c) => c.toUpperCase())];
  if (placeName) pieces.push(`in ${placeName}`);
  const evidence = matchedTerms.filter((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(`${listing.title} ${listing.description} ${listing.amenities.join(' ')}`)).slice(0, 2);
  if (evidence.length) pieces.push(`matches ${evidence.join(' and ')}`);
  if (listing.pets_allowed) pieces.push('pets welcome');
  return pieces.join(' · ');
}

@Injectable()
export class SearchService {
  constructor(private readonly catalog: CatalogService, private readonly inventory: InventoryClient) {}

  async search(req: { q: string; limit: number }, ctx: { tenant: string; now: string }): Promise<{ results: SearchResult[]; understood: Record<string, unknown> }> {
    const q = req.q.trim();
    if (!q) throw new BadRequestException('q must be a non-empty search sentence.');
    if (!this.catalog.tenants.some((tenant) => tenant.id === ctx.tenant)) throw new BadRequestException('x-tenant must identify an authenticated tenant.');
    const placeScope = findPlaceScope(q, this.catalog.places);
    const place = placeScope.places[0] ?? null;
    const near = /\bnear\b|\bnearby\b|\baround\b|\bclose to\b/i.test(q);
    const guests = parseGuests(q);
    const pets = /\b(dog|dogs|pet|pets|cat|puppy|pup)\b/i.test(q) && !/\b(no|without|don't want|do not want)\s+(a\s+)?(dog|dogs|pet|pets|cat)\b/i.test(q);
    const dateRange = parseDateRange(q, ctx.now);
    const price = parsePrice(q);
    const normalizedLimit = Math.max(1, Math.min(50, Math.floor(req.limit || 10)));
    const qVector = embed(q);
    const semanticTerms = CONCEPT_KEYS.filter((_, i) => qVector[i] > 0);

    // Tenant visibility and all explicit hard constraints are applied before any candidate can be returned.
    const candidates = this.catalog.listings.filter((listing) => {
      if (listing.visibility !== 'public' && listing.visibility !== `private:${ctx.tenant}`) return false;
      if (guests !== null && listing.sleeps < guests) return false;
      if (pets && !listing.pets_allowed) return false;
      if (placeScope.places.length) {
        const target = this.catalog.places.find((p) => p.id === listing.place_id);
        if (!target || (near ? Math.min(...placeScope.places.map((p) => distanceKm(p, listing))) > PLACE_RADIUS_KM : !placeScope.places.some((p) => p.id === listing.place_id))) return false;
      }
      return true;
    });
    const quotes = await this.quoteAll(candidates.map((listing) => listing.id), dateRange);
    const byId = new Map(quotes.map((quote) => [quote.listing_id, quote]));
    const eligible = candidates.flatMap((listing) => {
      const quote = byId.get(listing.id);
      if (!quote || !quote.available) return [];
      if (price && price.currency && quote.currency !== price.currency) return [];
      const cost = price?.mode === 'total' ? quote.total : quote.nightly_avg;
      if (price && (cost === null || cost > price.amount)) return [];
      const score = semanticScore(qVector, q, listing, place) + Math.min(listing.rating, 5) * 0.015 + Math.log1p(listing.reviews) * 0.002;
      return [{ listing, quote, score }];
    });
    eligible.sort((a, b) => b.score - a.score || (a.quote.nightly_avg ?? Infinity) - (b.quote.nightly_avg ?? Infinity) || a.listing.id.localeCompare(b.listing.id));
    return {
      results: eligible.slice(0, normalizedLimit).map(({ listing, quote }) => ({
        listing_id: listing.id,
        title: listing.title,
        nightly_avg: quote.nightly_avg,
        total: quote.total,
        currency: quote.currency,
        why: formatWhy(listing, placeScope.label || null, semanticTerms),
      })),
      understood: {
        tenant: ctx.tenant,
        place: place ? { id: placeScope.places.length === 1 ? place.id : null, name: placeScope.label, near, radius_km: near ? PLACE_RADIUS_KM : 0, matches: placeScope.places.map((p) => p.id) } : null,
        guests,
        pets_required: pets,
        dates: { check_in: dateRange.checkIn, check_out: dateRange.checkOut, nights: dateRange.nights, interpreted_as: dateRange.source },
        price: price ? { maximum: price.amount, currency: price.currency ?? 'listing currency', applies_to: price.mode } : null,
        semantic_concepts: semanticTerms,
      },
    };
  }

  private async quoteAll(ids: string[], range: DateRange): Promise<Quote[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
    const batches = await Promise.all(chunks.map((batch) => this.inventory.quotes(batch, range.checkIn, range.checkOut)));
    return batches.flat();
  }
}
