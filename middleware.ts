// ─────────────────────────────────────────────────────────────────────────
// middleware.ts — Vercel Edge-middleware som gater hele appen bak PIN
//
// Kjører før hver request som matcher `config.matcher` (se nederst).
// Logikk:
//   1. Hvis tind_session-cookien er til stede OG gyldig (HMAC + ikke utløpt)
//      → slipper requesten igjennom uendret (next()).
//   2. Ellers:
//        - /api/* → 401 JSON (appen kan fange den og reloade til /login)
//        - alt annet (HTML/asset) → 307 redirect til /login?next=<original>
//
// Statiske assets (logo, favicon) og selve login-siden + /api/auth er
// UNNGÅTT i matcheren slik at innloggings-flyten ikke gater seg selv.
// ─────────────────────────────────────────────────────────────────────────

import { next } from '@vercel/edge';
import { COOKIE_NAME, parseCookie, verifySessionCookieValue } from './src/auth.js';

export const config = {
  // Alt unntatt /login, /api/auth og rå statiske ressurser som login-siden
  // og brand-assets trenger. Legg merke til at vi IKKE unntar /api/data —
  // den må være bak PIN-en. Vercels matcher bruker path-to-regexp-syntaks,
  // men denne projekt-typen godtar også et rent regex-mønster via ((?!...))
  matcher: [
    '/((?!login|api/auth|favicon\\.svg|logos/).*)',
  ],
};

export default async function middleware(request: Request): Promise<Response> {
  const secret = process.env.SESSION_SECRET || '';
  const cookieHeader = request.headers.get('cookie');
  const cookieValue = parseCookie(cookieHeader, COOKIE_NAME);

  // Hvis miljøet ikke er konfigurert (ingen SESSION_SECRET) kan vi ikke
  // verifisere noe — da er ingen autorisert. Dette er "fail closed".
  const ok = secret ? await verifySessionCookieValue(cookieValue, secret) : false;

  if (ok) return next();

  const url = new URL(request.url);

  // API-kall skal ikke få en HTML-redirect — de skal få en proper 401
  // slik at frontend kan fange det og reloade siden.
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Ellers: redirect til login med ?next= slik at vi kan hoppe tilbake
  // til siden brukeren prøvde å nå (f.eks. hvis det noen gang blir flere).
  const loginUrl = new URL('/login', url);
  const nextTarget = url.pathname + url.search;
  if (nextTarget !== '/' && nextTarget !== '/login') {
    loginUrl.searchParams.set('next', nextTarget);
  }
  return Response.redirect(loginUrl.toString(), 307);
}
