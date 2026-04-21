// ─────────────────────────────────────────────────────────────────────────
// auth.ts — Delt sesjons-logikk for PIN-gate
//
// Brukes av:
//   - middleware.ts   (Vercel Edge runtime — sjekker cookie på hver request)
//   - api/auth.ts     (Node runtime — validerer PIN og utsteder cookie)
//   - dev-server.ts   (lokalt Node — speiler middleware + /api/auth)
//
// Alt her bruker Web Crypto (globalThis.crypto.subtle) slik at samme
// kode kjører både i Edge og Node 18+. Ingen avhengigheter utenom miljøet.
// ─────────────────────────────────────────────────────────────────────────

export const COOKIE_NAME = 'tind_session';
// 30 dager — TV-ene står på hele tiden, vi vil ikke at de skal logges ut ofte.
export const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return b64urlEncode(new Uint8Array(sig));
}

// Konstant-tid-sammenligning for å unngå timing-angrep ved cookie-verifisering.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Cookie-format: "<issuedAtSeconds>.<hmac>"
// Enkel og selvbeskrivende — ingen JWT-biblioteker nødvendig.
export async function createSessionCookieValue(secret: string): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = String(issuedAt);
  const sig = await hmacSha256(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifySessionCookieValue(
  value: string | undefined | null,
  secret: string,
): Promise<boolean> {
  if (!value || !secret) return false;
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const issuedAt = Number(payload);
  if (!Number.isFinite(issuedAt)) return false;
  // Utløpt?
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - issuedAt > COOKIE_MAX_AGE_SECONDS) return false;
  // Signaturen må matche eksakt.
  const expected = await hmacSha256(secret, payload);
  return timingSafeEqual(sig, expected);
}

// Bygger en Set-Cookie-streng klar til å settes i response-headeren.
// HttpOnly + Secure + SameSite=Lax + Path=/ slik at TV-ene holder session
// på tvers av faner og at cookien ikke kan leses fra JavaScript.
export function buildSetCookieHeader(value: string, opts?: { secure?: boolean }): string {
  const secure = opts?.secure !== false;
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// Tømmer cookien (utlogging): samme navn, Max-Age=0.
export function buildClearCookieHeader(opts?: { secure?: boolean }): string {
  const secure = opts?.secure !== false;
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// Liten cookie-parser som fungerer både i Edge og Node.
export function parseCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
