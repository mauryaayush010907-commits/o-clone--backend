/**
 * Optional matchmaking preferences — shared vocabulary, validation, and
 * compatibility logic.
 *
 * Everything is OPTIONAL: an empty preference set means "match me with
 * anyone instantly" (standard random matchmaking). Users who never open the
 * filter panel get exactly the legacy behavior.
 *
 * Shape after sanitizePrefs():
 * {
 *   // filters — who I want to be matched with
 *   countries:  ["us","de"],        // empty = worldwide
 *   languages:  ["en","es"],        // empty = any language
 *   gender:     "female" | null,    // null = everyone
 *   // about-me — optional, self-reported, UNVERIFIED. Helps others' filters find you.
 *   myCountry:  "us" | null,
 *   myGender:   "male" | null,
 *   myLanguage: "en" | null,        // typically auto-detected (navigator.language)
 * }
 */

export const GENDER_VALUES = ["male", "female"];

// Full ISO 3166-1 alpha-2 country list, sorted by display name. "xx" is the
// reserved "Prefer not to say" pseudo-code used by the "About you" selector.
export const COUNTRIES = (() => {
  const list = [
    ["af", "Afghanistan"], ["al", "Albania"], ["dz", "Algeria"], ["ad", "Andorra"], ["ao", "Angola"],
    ["ag", "Antigua and Barbuda"], ["ar", "Argentina"], ["am", "Armenia"], ["au", "Australia"], ["at", "Austria"],
    ["az", "Azerbaijan"], ["bs", "Bahamas"], ["bh", "Bahrain"], ["bd", "Bangladesh"], ["bb", "Barbados"],
    ["by", "Belarus"], ["be", "Belgium"], ["bz", "Belize"], ["bj", "Benin"], ["bt", "Bhutan"],
    ["bo", "Bolivia"], ["ba", "Bosnia and Herzegovina"], ["bw", "Botswana"], ["br", "Brazil"], ["bn", "Brunei"],
    ["bg", "Bulgaria"], ["bf", "Burkina Faso"], ["bi", "Burundi"], ["kh", "Cambodia"], ["cm", "Cameroon"],
    ["ca", "Canada"], ["cv", "Cape Verde"], ["cf", "Central African Republic"], ["td", "Chad"], ["cl", "Chile"],
    ["cn", "China"], ["co", "Colombia"], ["km", "Comoros"], ["cg", "Congo"], ["cr", "Costa Rica"],
    ["ci", "Côte d'Ivoire"], ["hr", "Croatia"], ["cu", "Cuba"], ["cy", "Cyprus"], ["cz", "Czechia"],
    ["dk", "Denmark"], ["dj", "Djibouti"], ["dm", "Dominica"], ["do", "Dominican Republic"], ["ec", "Ecuador"],
    ["eg", "Egypt"], ["sv", "El Salvador"], ["gq", "Equatorial Guinea"], ["er", "Eritrea"], ["ee", "Estonia"],
    ["et", "Ethiopia"], ["fj", "Fiji"], ["fi", "Finland"], ["fr", "France"], ["ga", "Gabon"],
    ["gm", "Gambia"], ["ge", "Georgia"], ["de", "Germany"], ["gh", "Ghana"], ["gr", "Greece"],
    ["gd", "Grenada"], ["gt", "Guatemala"], ["gn", "Guinea"], ["gw", "Guinea-Bissau"], ["gy", "Guyana"],
    ["ht", "Haiti"], ["hn", "Honduras"], ["hk", "Hong Kong"], ["hu", "Hungary"], ["is", "Iceland"],
    ["in", "India"], ["id", "Indonesia"], ["ir", "Iran"], ["iq", "Iraq"], ["ie", "Ireland"],
    ["il", "Israel"], ["it", "Italy"], ["jm", "Jamaica"], ["jp", "Japan"], ["jo", "Jordan"],
    ["kz", "Kazakhstan"], ["ke", "Kenya"], ["ki", "Kiribati"], ["kw", "Kuwait"], ["kg", "Kyrgyzstan"],
    ["la", "Laos"], ["lv", "Latvia"], ["lb", "Lebanon"], ["ls", "Lesotho"], ["lr", "Liberia"],
    ["ly", "Libya"], ["li", "Liechtenstein"], ["lt", "Lithuania"], ["lu", "Luxembourg"], ["mo", "Macau"],
    ["mg", "Madagascar"], ["mw", "Malawi"], ["my", "Malaysia"], ["mv", "Maldives"], ["ml", "Mali"],
    ["mt", "Malta"], ["mh", "Marshall Islands"], ["mr", "Mauritania"], ["mu", "Mauritius"], ["mx", "Mexico"],
    ["fm", "Micronesia"], ["md", "Moldova"], ["mc", "Monaco"], ["mn", "Mongolia"], ["me", "Montenegro"],
    ["ma", "Morocco"], ["mz", "Mozambique"], ["mm", "Myanmar"], ["na", "Namibia"], ["nr", "Nauru"],
    ["np", "Nepal"], ["nl", "Netherlands"], ["nz", "New Zealand"], ["ni", "Nicaragua"], ["ne", "Niger"],
    ["ng", "Nigeria"], ["kp", "North Korea"], ["mk", "North Macedonia"], ["no", "Norway"], ["om", "Oman"],
    ["pk", "Pakistan"], ["pw", "Palau"], ["ps", "Palestine"], ["pa", "Panama"], ["pg", "Papua New Guinea"],
    ["py", "Paraguay"], ["pe", "Peru"], ["ph", "Philippines"], ["pl", "Poland"], ["pt", "Portugal"],
    ["qa", "Qatar"], ["ro", "Romania"], ["ru", "Russia"], ["rw", "Rwanda"], ["kn", "Saint Kitts and Nevis"],
    ["lc", "Saint Lucia"], ["vc", "Saint Vincent and the Grenadines"], ["ws", "Samoa"], ["sm", "San Marino"],
    ["st", "São Tomé and Príncipe"], ["sa", "Saudi Arabia"], ["sn", "Senegal"], ["rs", "Serbia"], ["sc", "Seychelles"],
    ["sl", "Sierra Leone"], ["sg", "Singapore"], ["sk", "Slovakia"], ["si", "Slovenia"], ["sb", "Solomon Islands"],
    ["so", "Somalia"], ["za", "South Africa"], ["kr", "South Korea"], ["ss", "South Sudan"], ["es", "Spain"],
    ["lk", "Sri Lanka"], ["sd", "Sudan"], ["sr", "Suriname"], ["se", "Sweden"], ["ch", "Switzerland"],
    ["sy", "Syria"], ["tw", "Taiwan"], ["tj", "Tajikistan"], ["tz", "Tanzania"], ["th", "Thailand"],
    ["tl", "Timor-Leste"], ["tg", "Togo"], ["to", "Tonga"], ["tt", "Trinidad and Tobago"], ["tn", "Tunisia"],
    ["tr", "Turkey"], ["tm", "Turkmenistan"], ["tv", "Tuvalu"], ["ug", "Uganda"], ["ua", "Ukraine"],
    ["ae", "United Arab Emirates"], ["gb", "United Kingdom"], ["us", "United States"], ["uy", "Uruguay"],
    ["uz", "Uzbekistan"], ["vu", "Vanuatu"], ["va", "Vatican City"], ["ve", "Venezuela"], ["vn", "Vietnam"],
    ["ye", "Yemen"], ["zm", "Zambia"], ["zw", "Zimbabwe"],
  ];
  return list
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
})();

export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "pt", name: "Portuguese" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "ru", name: "Russian" },
  { code: "zh", name: "Chinese" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "hi", name: "Hindi" },
  { code: "ar", name: "Arabic" },
  { code: "tr", name: "Turkish" },
  { code: "pl", name: "Polish" },
  { code: "nl", name: "Dutch" },
  { code: "sv", name: "Swedish" },
  { code: "no", name: "Norwegian" },
  { code: "fi", name: "Finnish" },
  { code: "da", name: "Danish" },
  { code: "cs", name: "Czech" },
  { code: "el", name: "Greek" },
  { code: "he", name: "Hebrew" },
  { code: "id", name: "Indonesian" },
  { code: "vi", name: "Vietnamese" },
  { code: "th", name: "Thai" },
  { code: "bn", name: "Bengali" },
  { code: "ur", name: "Urdu" },
  { code: "uk", name: "Ukrainian" },
  { code: "fa", name: "Persian" },
  { code: "ro", name: "Romanian" },
  { code: "hu", name: "Hungarian" },
];

// Per-request caps enforced by sanitizePrefs(). Exported so the UI can warn
// the user before they hit the limit (instead of silently truncating).
export const MAX_COUNTRIES = 5;
export const MAX_LANGUAGES = 5;

const norm = (v) => String(v || "").trim().toLowerCase();
const knownCountry = (c) => c === "xx" || COUNTRIES.some((x) => x.code === c);
const knownLanguage = (c) => LANGUAGES.some((x) => x.code === c);

export function emptyPrefs() {
  return {
    countries: [],
    languages: [],
    gender: null,
    myCountry: null,
    myGender: null,
    myLanguage: null,
  };
}

/** Defensive validation: strips unknown values, trims sizes, normalizes case. Never throws. */
export function sanitizePrefs(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = emptyPrefs();
  if (Array.isArray(r.countries)) {
    out.countries = [...new Set(r.countries.map(norm).filter(knownCountry))].slice(0, MAX_COUNTRIES);
  }
  if (Array.isArray(r.languages)) {
    out.languages = [...new Set(r.languages.map(norm).filter(knownLanguage))].slice(0, MAX_LANGUAGES);
  }
  if (GENDER_VALUES.includes(norm(r.gender))) out.gender = norm(r.gender);
  if (knownCountry(r.myCountry)) out.myCountry = norm(r.myCountry);
  if (GENDER_VALUES.includes(norm(r.myGender))) out.myGender = norm(r.myGender);
  // myLanguage: client-supplied (typically auto-detected from navigator.language).
  // We accept any lowercase two-letter code, but the sanitizer is permissive
  // here — the matcher only requires a non-empty match against the partner's
  // language filter, and missing/empty is just an unknown profile field.
  const ml = norm(r.myLanguage).split("-")[0];
  if (ml && /^[a-z]{2,3}$/.test(ml)) out.myLanguage = ml;
  return out;
}

/** Number of ACTIVE FILTERS (preferences about the partner, not about-me fields). */
export function activeCount(p) {
  if (!p) return 0;
  return (p.countries?.length || 0) + (p.languages?.length || 0) + (p.gender ? 1 : 0);
}

/** Extract the self-reported profile (used by OTHER users' filters). */
export function profileOf(p) {
  return {
    country: p.myCountry || null,
    language: p.myLanguage || null,
    gender: p.myGender || null,
  };
}

/** Filter part of a prefs object (about-me fields excluded). */
export function filtersOf(p) {
  return {
    countries: Array.isArray(p?.countries) ? p.countries : [],
    languages: Array.isArray(p?.languages) ? p.languages : [],
    gender: p?.gender || null,
  };
}

/** Does `profile` pass the `filters` set? Unknown profile fields fail a strict filter (they may still match after expansion). */
export function satisfies(filters, profile) {
  if (filters.countries?.length && !(profile.country && filters.countries.includes(profile.country))) return false;
  if (filters.languages?.length && !(profile.language && filters.languages.includes(profile.language))) return false;
  if (filters.gender && profile.gender !== filters.gender) return false;
  return true;
}

/**
 * A pair is compatible when BOTH users' explicit filters (fA, fB) are
 * satisfied by the other's (self-reported) profile (pA, pB). Empty filter
 * sets always pass — so unfiltered users keep instant random matching, and
 * users with unset profile fields are never removed from the pool.
 */
export function pairCompatible(fA, pA, fB, pB) {
  return satisfies(fA, pB) && satisfies(fB, pA);
}
