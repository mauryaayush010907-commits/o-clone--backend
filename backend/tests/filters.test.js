/**
 * Optional matchmaking filter tests: compatibility matching, visible
 * expansion (auto + manual), validation, and the "no filters = legacy
 * instant random matching" baseline.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore } from "../src/store.js";
import { createMatchmaker } from "../src/matchmaker.js";
import { sanitizePrefs, activeCount, COUNTRIES, MAX_COUNTRIES } from "../src/prefs.js";

const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const CFG = { findCooldownMs: 0, sessionTtlMs: 600000, queueMaxAgeMs: 120000, prefsPatienceMs: 30 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeIo() {
  const socketsMap = new Map();
  const out = new Map();
  return {
    sockets: { sockets: socketsMap },
    out,
    add(id) {
      if (!socketsMap.has(id)) {
        socketsMap.set(id, {});
        out.set(id, []);
      }
    },
    to(id) {
      return { emit: (ev, d) => out.get(id)?.push([ev, d]) };
    },
  };
}

function setup(cfg = CFG) {
  const store = new MemoryStore();
  const io = fakeIo();
  const mm = createMatchmaker({ store, io, log: LOG, cfg });
  const events = (id, ev) => (io.out.get(id) || []).filter(([e]) => e === ev).map(([, d]) => d);
  return { store, io, mm, events };
}

describe("optional matchmaking filters", () => {
  it("baseline: unfiltered users still match instantly (legacy behavior unchanged)", async () => {
    const { store, io, mm, events } = setup();
    io.add("a");
    io.add("b");
    await mm.find("a", "video");
    const r = await mm.find("b", "video");
    expect(r.matched).toBeTruthy();
    expect(events("a", "match:queued")[0]).toMatchObject({ mode: "video", refined: false });
    expect(await store.queueLength("video")).toBe(0);
    mm.close();
  });

  it("country filter: compatible waiter pairs immediately", async () => {
    const { io, mm, events } = setup();
    io.add("a");
    io.add("b");
    await mm.find("a", "video", sanitizePrefs({ myCountry: "de" })); // waiting, from Germany
    const r = await mm.find("b", "video", sanitizePrefs({ countries: ["de"] })); // wants Germany
    expect(r.matched).toBeTruthy();
    expect(events("b", "match:found")[0].role).toBe("answerer");
    expect(events("a", "match:found")[0].role).toBe("offerer"); // a waited longer
    mm.close();
  });

  it("incompatible country filters wait, then auto-expand (with notification) and match", async () => {
    const { store, io, mm, events } = setup();
    io.add("a");
    io.add("b");
    const ra = await mm.find("a", "video", sanitizePrefs({ countries: ["us"], myCountry: "de" }));
    expect(ra.queued).toBe(true);
    expect(ra.refined).toBe(true);
    expect(events("a", "match:queued")[0]).toMatchObject({ refined: true });

    const rb = await mm.find("b", "video", sanitizePrefs({ myCountry: "de" })); // b has no filters → cannot satisfy a
    expect(rb.queued).toBe(true);
    expect(await store.queueLength("video")).toBe(2);

    // patience 30ms → a expands, is told so, and pairs with b
    await sleep(120);
    expect(events("a", "match:expanding").length).toBe(1);
    expect(events("a", "match:found").length).toBe(1);
    expect(events("b", "match:found").length).toBe(1);
    expect(events("a", "match:found")[0].matchId).toBe(events("b", "match:found")[0].matchId);
    mm.close();
  });

  it("manual match:expand widens the search immediately", async () => {
    const { io, mm, events } = setup();
    io.add("a");
    io.add("b");
    await mm.find("a", "video", sanitizePrefs({ countries: ["us"], myCountry: "de" }));
    await mm.find("b", "video", sanitizePrefs({ myCountry: "de" }));
    expect(events("a", "match:found").length).toBe(0);

    await mm.expand("a");
    expect(events("a", "match:expanding").length).toBe(1);
    expect(events("a", "match:found").length).toBe(1);
    expect(events("b", "match:found").length).toBe(1);
    mm.close();
  });

  it("mutual gender preferences match immediately", async () => {
    const { io, mm } = setup();
    io.add("a");
    io.add("b");
    await mm.find("a", "text", sanitizePrefs({ myGender: "male", gender: "female" }));
    const r = await mm.find("b", "text", sanitizePrefs({ myGender: "female", gender: "male" }));
    expect(r.matched).toBeTruthy();
    mm.close();
  });

  it("unverified (unset) profile fields block strict matches until expansion", async () => {
    const { io, mm, events } = setup();
    io.add("a");
    io.add("b");
    await mm.find("a", "video", sanitizePrefs({ gender: "female" }));
    const rb = await mm.find("b", "video"); // b never self-reported anything
    expect(rb.queued).toBe(true); // strict filter must not silently ignore a's preference
    await sleep(120);
    expect(events("a", "match:expanding").length).toBe(1);
    expect(events("a", "match:found").length).toBe(1);
    expect(events("b", "match:found").length).toBe(1);
    mm.close();
  });

  it("language filter requires an exact code match on both sides", async () => {
    const t1 = setup();
    t1.io.add("a");
    t1.io.add("b");
    // a wants English; b reports English via auto-detected myLanguage → match
    await t1.mm.find("a", "video", sanitizePrefs({ languages: ["en"] }));
    const r1 = await t1.mm.find("b", "video", sanitizePrefs({ myLanguage: "en" }));
    expect(r1.matched).toBeTruthy();
    t1.mm.close();

    // a wants English; b reports only Spanish → no match, both keep waiting
    const t2 = setup();
    t2.io.add("a");
    t2.io.add("b");
    await t2.mm.find("a", "video", sanitizePrefs({ languages: ["en"] }));
    const r2 = await t2.mm.find("b", "video", sanitizePrefs({ myLanguage: "es" }));
    expect(r2.queued).toBe(true);
    // a remains in the queue, b remains in the queue
    expect(t2.events("a", "match:found").length).toBe(0);
    expect(t2.events("b", "match:found").length).toBe(0);
    t2.mm.close();
  });

  it("filters never cross chat modes", async () => {
    const { store, io, mm, events } = setup();
    io.add("a");
    io.add("b");
    await mm.find("a", "video", sanitizePrefs({ countries: ["de"] }));
    const rb = await mm.find("b", "text", sanitizePrefs({ myCountry: "de" }));
    expect(rb.queued).toBe(true);
    expect(events("a", "match:found").length).toBe(0);
    expect(await store.queueLength("video")).toBe(1);
    expect(await store.queueLength("text")).toBe(1);
    mm.close();
  });

  it("cancelling and re-finding without prefs restores instant matching", async () => {
    const { store, io, mm } = setup();
    io.add("a");
    io.add("b");
    await mm.find("a", "video", sanitizePrefs({ countries: ["us"] }));
    await mm.cancel("a");
    expect(await store.queueLength("video")).toBe(0);
    await mm.find("b", "video", sanitizePrefs({ myCountry: "de" }));
    const ra = await mm.find("a", "video"); // no filters now
    expect(ra.matched).toBeTruthy();
    mm.close();
  });

  it("expansion never silently matches users whose own filters remain unsatisfied", async () => {
    const { store, io, mm, events } = setup();
    io.add("a");
    io.add("b");
    io.add("c");
    // a: wants "us", is de. b: wants "us" too, is de. c: from us, no filters.
    await mm.find("a", "video", sanitizePrefs({ countries: ["us"], myCountry: "de" }));
    await mm.find("b", "video", sanitizePrefs({ countries: ["us"], myCountry: "de" }));
    await mm.expand("a");
    // b's strict filter (wants us) cannot be satisfied by a (de) → a must keep waiting,
    // NOT silently match b despite being expanded.
    expect(events("a", "match:found").length).toBe(0);
    expect(events("b", "match:found").length).toBe(0);
    await mm.find("c", "video", sanitizePrefs({ myCountry: "us" }));
    // c (no filters) pairs with a: a is the oldest waiter and is already expanded.
    expect(events("a", "match:found").length).toBe(1);
    expect(events("c", "match:found").length).toBe(1);
    expect(events("b", "match:found").length).toBe(0);
    expect(await store.queueLength("video")).toBe(1); // b still waiting
    mm.close();
  });

  it("backend validation strips unknown/oversized preference values", () => {
    const p = sanitizePrefs({
      gender: "robot",
      countries: ["XX", "US", "us", "zz", "de", "fr", "it", "nl", "be"],
      languages: ["EN", "en", "zz", "fr", "es", "de", "xx", "yy"],
      myCountry: "jp",
      myGender: "androgynous",
    });
    expect(p.gender).toBeNull();
    expect(p.countries).toEqual(["xx", "us", "de", "fr", "it"]); // invalid + over-cap entries removed
    expect(p.languages).toEqual(["en", "fr", "es", "de"]); // deduped, normalized, capped; "xx" is not a real language code
    expect(p.myCountry).toBe("jp");
    expect(p.myGender).toBeNull();
    expect(activeCount(p)).toBe(9); // 5 countries + 4 languages + 0 gender
  });

  it("garbage prefs payloads never crash and degrade to no-filter matching", async () => {
    const { io, mm } = setup();
    io.add("a");
    io.add("b");
    const r1 = await mm.find("a", "video", "not-an-object");
    expect(r1.queued).toBe(true);
    expect(r1.refined).toBe(false);
    const r2 = await mm.find("b", "video", { countries: "de", gender: 42, languages: { a: 1 } });
    expect(r2.matched).toBeTruthy(); // both effectively unfiltered → instant
    mm.close();
  });

  it("exposes the full ISO 3166-1 country list to clients and enforces the cap", () => {
    // The complete list is what the UI renders (no client-side truncation).
    expect(COUNTRIES.length).toBeGreaterThanOrEqual(190);
    // Sanity: a few well-known codes must be present.
    const codes = new Set(COUNTRIES.map((c) => c.code));
    for (const expected of ["us", "gb", "fr", "de", "jp", "br", "in", "au", "ca", "cn", "za", "ng", "eg"]) {
      expect(codes.has(expected)).toBe(true);
    }
    // The list is sorted by display name.
    for (let i = 1; i < COUNTRIES.length; i++) {
      expect(COUNTRIES[i - 1].name.localeCompare(COUNTRIES[i].name, "en")).toBeLessThanOrEqual(0);
    }
    // sanitizePrefs caps the user's selection at MAX_COUNTRIES (5).
    const huge = Array.from({ length: 20 }, (_, i) => COUNTRIES[i].code);
    const capped = sanitizePrefs({ countries: huge });
    expect(capped.countries.length).toBe(MAX_COUNTRIES);
  });
});
