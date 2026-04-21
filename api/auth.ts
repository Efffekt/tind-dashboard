// ─────────────────────────────────────────────────────────────────────────
// api/auth.ts — PIN-innlogging
//
// Flyt:
//   1. POST /api/auth med { "pin": "8080" } (JSON-body)
//   2. Sammenligner mot DASHBOARD_PIN env var
//   3. Ved match: utsteder signert HttpOnly cookie (30 dagers levetid)
//   4. Ved feil: 401 uten cookie
//
// POST /api/auth?logout=1 tømmer cookien (utlogging).
//
// Selve cookie-formatet + signering lever i src/auth.ts slik at middleware
// og dev-server bruker samme verifisering.
// ─────────────────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  createSessionCookieValue,
} from '../src/auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Utlogging — tøm cookien.
  if (req.query?.logout) {
    res.setHeader('Set-Cookie', buildClearCookieHeader());
    return res.status(200).json({ ok: true });
  }

  const expectedPin = process.env.DASHBOARD_PIN || '';
  const secret = process.env.SESSION_SECRET || '';

  // Hvis serveren er feilkonfigurert (mangler env vars) er det en 500,
  // ikke en 401 — vi vil ikke at feil oppsett skal se ut som feil PIN.
  if (!expectedPin || !secret) {
    return res.status(500).json({ error: 'Server not configured (missing DASHBOARD_PIN or SESSION_SECRET)' });
  }

  // Body kan være parset JSON eller en rå streng — begge håndteres.
  let pin = '';
  const body: any = req.body;
  if (body && typeof body === 'object' && typeof body.pin === 'string') {
    pin = body.pin;
  } else if (typeof body === 'string') {
    try { pin = JSON.parse(body)?.pin ?? ''; } catch { pin = ''; }
  }

  // Strikt eq. Konstant-tid trengs ikke her siden PIN-en er kort nok og
  // vi ikke frykter timing-angrep på en 4-sifret kode (brute force er
  // uansett trivielt — derfor bør vi legge til rate limiting senere).
  if (pin !== expectedPin) {
    return res.status(401).json({ error: 'Invalid PIN' });
  }

  const cookieValue = await createSessionCookieValue(secret);
  res.setHeader('Set-Cookie', buildSetCookieHeader(cookieValue));
  return res.status(200).json({ ok: true });
}
