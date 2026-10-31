/**
 * Compile-time regression fixture for the Antigravity pool rails.
 *
 * Included by `tsconfig.json` (the whole `test` directory) but never run: it
 * ends in `.typecheck.ts`, which `npm test`'s `test/*.test.ts` glob does not
 * match. Its only purpose is that `npm run typecheck` fails if any guarantee
 * below stops holding — every `@ts-expect-error` is checked to actually suppress
 * an error, so widening a signature turns the build red rather than quietly
 * accepting a call this design exists to refuse.
 *
 * The guarantees, in order: an Antigravity pool has no single-rail fetch; the
 * grouped fetch takes a pool and not the metered rail; every rail's readings are
 * a required key of `KnownReadings`; a pool's readings are never the metered
 * arm; and the generator document carries all six rails.
 */
import type { AntigravityReadings, KnownReadings, SharedReadings } from "../src/index.ts";
import type { MeteredRailReadings, VendorRailReadings } from "../src/rail-reading.ts";
import { generatorInput } from "../src/index.ts";
import type { GeneratorInput, GeneratorRailInput } from "../src/generator.ts";

declare const store: SharedReadings;
declare const credential: string;
declare const group: AntigravityReadings;
declare const known: KnownReadings;
declare const vendor: VendorRailReadings;

// The grouped method is the one way to ask about a pool, and it is typed to
// answer exactly that.
const argon: Promise<VendorRailReadings> = store.readAntigravity("antigravity-argon", credential, {
  ttlMs: 1,
  fetch: async () => group,
});

// @ts-expect-error a pool is answered by one request for all three, so it has no single-rail read
store.read("antigravity-argon", credential, { ttlMs: 1, fetch: async () => group["antigravity-argon"] });
// @ts-expect-error the grouped read takes a pool; the metered rail has no endpoint at all
store.readAntigravity("deepseek", credential, { ttlMs: 1, fetch: async () => group });
// @ts-expect-error a Claude read is not answered by an Antigravity group
store.readAntigravity("claude", credential, { ttlMs: 1, fetch: async () => group });

// Every rail is a required key, so a caller cannot forget a pool.
const { claude, codex, deepseek } = known;
// @ts-expect-error a known-readings record missing the three pools is not one
const incomplete: KnownReadings = { claude, codex, deepseek };
const metered: MeteredRailReadings = known.deepseek;
// @ts-expect-error a pool is quota-capped, so it is never the metered arm
const meteredPool: KnownReadings["antigravity-gemini"] = metered;

// The generator document names every rail, at version 1.
const outcome = generatorInput(known);
if (outcome.kind === "ready") {
  const input: GeneratorInput = outcome.input;
  const one: GeneratorRailInput = input.rails["antigravity-3p"];
  void one;
}

// A value that is only ever read is used here so the file has no unused locals.
void [argon, incomplete, meteredPool, vendor];
