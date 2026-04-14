// ─────────────────────────────────────────────────────────────────────────
// config.ts — Leser env-variabler og samler dem i ett konfig-objekt
//
// Alle andre filer importerer `config` herfra i stedet for å bruke
// process.env direkte. Fordel: ett sted å endre hvis vi vil omdøpe noe,
// og TypeScript kan autokomplete feltene.
//
// Env-variabler kommer fra:
//   - .env-fil lokalt (lastet manuelt av dev-server.ts)
//   - Vercel env vars i produksjon (satt via dashbordet)
//
// Hvis en variabel mangler, blir verdien en tom streng og tjenesten
// som bruker den vil feile med en tydelig feilmelding ved første kall.
// ─────────────────────────────────────────────────────────────────────────

export const config = {
  shiphero: {
    // GraphQL-endepunktet er det samme for alle ShipHero-kontoer.
    endpoint: 'https://public-api.shiphero.com/graphql',
    // Short-lived access-token (~28 dager). Brukes først ved kaldstart,
    // så automatisk fornyet av shiphero.ts hvis det utløper.
    accessToken: process.env.SHIPHERO_ACCESS_TOKEN || '',
    // Long-lived refresh-token. Brukes av refreshAccessToken()
    // for å hente et nytt access-token når det gamle har utløpt.
    refreshToken: process.env.SHIPHERO_REFRESH_TOKEN || '',
  },

  packiyo: {
    // Tenant-spesifikk URL. For Tind: https://tindlogistics.app.packiyo.com
    // (Hver Packiyo-kunde har sin egen subdomene.)
    baseUrl: process.env.PACKIYO_BASE_URL || '',
    // Long-lived bearer-token. Packiyo-tokens utløper ikke automatisk,
    // så ingen refresh-logikk er nødvendig.
    token: process.env.PACKIYO_TOKEN || '',
  },
};
