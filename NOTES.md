# Search implementation notes

## What I built

`POST /v1/search` parses the tenant, place, guest count, pet requirement, stay dates, and price ceiling. The hard filters run before results are returned. A caller sees public listings and listings marked private for that caller's tenant only. Semantic ranking uses the bundled offline travel-concept vectors plus small exact-title and description matches, ratings, and review counts. Each surviving candidate is quoted from the inventory service in batches of at most 50; unavailable stays and prices outside the requested ceiling are removed. Returned totals, nightly averages, and currencies are from those live quotes.

## Assumptions

- `near` means within 40 km of the named place; a place name without “near” is an exact place match.
- A named weekend is Friday and Saturday nights. On Saturday, “this weekend” means that night's stay. “First weekend of October” means the first Friday and Saturday in October.
- A query without dates defaults to one night starting seven days after `x-now`. “For N nights” also starts seven days after `x-now` unless the query says tonight or today.
- A price ceiling means nightly average unless the guest says total, all nights, or for the stay. A currency symbol limits results to that currency; no exchange rates are inferred.
- Listing type words such as “cabin” and “apartment” are ranking preferences, not exclusion filters. Location, guests, pets, dates, price, availability, and tenant privacy are enforced as hard rules.

## How I measured it

`eval/queries.jsonl` contains 20 manually judged queries with graded relevance (0–3) based on type, requested attributes, and location fit. `eval.sh` calls the running API, calculates nDCG@10 and recall@10, checks every returned listing against the hard constraints and tenant visibility, re-queries inventory to compare availability and live price fields, and reports mean and p95 response time. The baseline starter only matched title words and had no judged set or live quote behavior, so its quality and price results are not directly comparable. On the local development inventory seed, the completed evaluation produced 20 queries, 0 hard-rule/live-price violations across 198 returned results, 0 quote mismatches, mean latency 62.4 ms, and p95 latency 91.9 ms. Ranking metrics are printed by the script from the committed judgments.

## Where I did not use vectors, and why

Vectors rank meaning only. Place, capacity, pet eligibility, date availability, nightly price, currency, and tenant visibility use deterministic checks because approximate similarity must never weaken those constraints. I used the provided compact concept vectors rather than an external embedding API because grading runs offline and the included model has no network or database dependency.

## What I would improve next

- Add broader date phrases such as “next month” and “the holiday weekend”.
- Replace the small bundled concept vocabulary with a stronger offline embedding model and expand the relevance judgments with reviewer agreement.
- Add request timeouts and bounded concurrency for the inventory service, plus structured search and quote-failure telemetry.
- Clarify price ceilings when a guest uses a currency that differs from a listing's currency; this build does not convert currencies.

## How I used AI

AI helped draft the parsing and evaluation approach. I checked the README contract, inspected the supplied data and inventory implementation, built the TypeScript app, exercised real search requests, and ran the evaluator against the local inventory service. Natural-language date assumptions are documented above and should be checked with the product team.
