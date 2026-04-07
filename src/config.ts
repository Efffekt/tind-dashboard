export const config = {
  shiphero: {
    endpoint: 'https://public-api.shiphero.com/graphql',
    accessToken: process.env.SHIPHERO_ACCESS_TOKEN || '',
    refreshToken: process.env.SHIPHERO_REFRESH_TOKEN || '',
  },

  packiyo: {
    baseUrl: process.env.PACKIYO_BASE_URL || '',
    token: process.env.PACKIYO_TOKEN || '',
    customerId: process.env.PACKIYO_CUSTOMER_ID || '',
  },
};
