/**
 * Development environment config (default).
 *
 * This file is used by `ng serve` and `ng build --configuration development`.
 * For production builds Angular swaps this file for `environment.prod.ts`
 * via the `fileReplacements` entry in angular.json.
 *
 * These values are NOT secrets — the browser needs them to reach Lex, and
 * Cognito only issues time-limited credentials scoped to the one bot alias.
 */
export const environment = {
  production: false,
  lex: {
    region: 'us-east-1',
    identityPoolId: 'us-east-1:17c84447-c827-4ebd-a323-926e44467e46',
    botId: '6COPKGRTBN',
    // Dev/test runs against the DRAFT version via the built-in test alias.
    botAliasId: 'TSTALIASID',
    localeId: 'es_419',
  },
  contact: {
    // POST endpoint from aws/setup-contact.sh (…/contact). Empty = the form
    // falls back to a mailto: link so it still works before the API is live.
    apiUrl: 'https://aczif5jdtg.execute-api.us-east-1.amazonaws.com/contact',
    email: 'hola@altioraestudio.com',
  },
  playground: {
    // Base endpoint from aws/setup-playground.sh (…/playground/polly etc).
    apiUrl: '',
  },
};
