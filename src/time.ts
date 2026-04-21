// ─────────────────────────────────────────────────────────────────────────
// time.ts — Dato-hjelpere brukt av KPI-beregninger
//
// Tind kjører fra Norge, så "i dag" betyr Europa/Oslo-tid. Vi beregner
// midnatts-starten på dagen og returnerer den som UTC ISO-streng slik at
// den kan sendes direkte til både ShipHero og Packiyo sine API-er.
// ─────────────────────────────────────────────────────────────────────────

// Starten av dagen i Europa/Oslo-tid, som UTC ISO-streng.
// Fungerer både i sommer- og vintertid fordi vi bruker Intl til å finne
// riktig UTC-offset for dagens dato, ikke hardkodet +01/+02.
export function osloMidnightIso(at: Date = new Date()): string {
  // Finn Y-M-D for "nå" i Oslo-tid.
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Oslo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const y = parts.find(p => p.type === 'year')!.value;
  const m = parts.find(p => p.type === 'month')!.value;
  const d = parts.find(p => p.type === 'day')!.value;

  // Finn UTC-offsettet for Oslo akkurat nå (±N timer).
  // DateTimeFormat med timeZoneName: 'shortOffset' gir "GMT+2" eller "GMT+1".
  const offsetPart = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo',
    timeZoneName: 'shortOffset',
  }).formatToParts(at).find(p => p.type === 'timeZoneName')?.value ?? 'GMT+0';
  // "GMT+2" → "+02:00" ; "GMT-1" → "-01:00" ; "GMT" → "+00:00"
  const match = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(offsetPart);
  const sign = match?.[1] ?? '+';
  const hh = (match?.[2] ?? '0').padStart(2, '0');
  const mm = (match?.[3] ?? '00').padStart(2, '0');
  const offset = `${sign}${hh}:${mm}`;

  // Bygg ISO-streng med Oslo-offset og konverter til UTC.
  return new Date(`${y}-${m}-${d}T00:00:00${offset}`).toISOString();
}
