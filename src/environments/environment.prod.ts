/**
 * Production environment config.
 *
 * Angular swaps `environment.ts` for this file during a production build
 * (see `fileReplacements` in angular.json).
 *
 * For the MVP, prod uses the same test alias (TSTALIASID) as dev — it runs
 * against the DRAFT version, which is what we have built. Later, to harden for
 * production: publish a bot version, create a dedicated "prod" alias, point
 * botAliasId at it, and update the IAM Resource ARN on the Cognito unauth role
 * to the new alias.
 */
export const environment = {
  production: true,
  lex: {
    region: 'us-east-1',
    identityPoolId: 'us-east-1:17c84447-c827-4ebd-a323-926e44467e46',
    botId: '6COPKGRTBN',
    // MVP: same alias as dev. Swap for a dedicated prod alias id when ready.
    botAliasId: 'TSTALIASID',
    localeId: 'es_419',
  },
  contact: {
    // POST endpoint from aws/setup-contact.sh (…/contact).
    apiUrl: 'https://aczif5jdtg.execute-api.us-east-1.amazonaws.com/contact',
    email: 'hola@altioraestudio.com',
  },
  playground: {
    apiUrl: '',
  },
};
