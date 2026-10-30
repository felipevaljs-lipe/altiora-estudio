/**
 * Production environment config.
 *
 * Angular swaps `environment.ts` for this file during a production build
 * (see `fileReplacements` in angular.json).
 *
 * IMPORTANT — before shipping to production, do the AWS steps in
 * `aws/PRODUCTION-ALIAS.md`:
 *   1. Publish a bot version.
 *   2. Create a dedicated alias (e.g. "prod") pointing at that version.
 *   3. Replace the placeholder below with the real alias id.
 *   4. Update the IAM Resource ARN on the Cognito unauth role to the new alias.
 */
export const environment = {
  production: true,
  lex: {
    region: 'us-east-1',
    identityPoolId: 'us-east-1:17c84447-c827-4ebd-a323-926e44467e46',
    botId: '6COPKGRTBN',
    // TODO: replace with the production alias id once the version is published.
    botAliasId: 'REPLACE_WITH_PROD_ALIAS_ID',
    localeId: 'es_419',
  },
  contact: {
    // POST endpoint from aws/setup-contact.sh (…/contact).
    apiUrl: '',
    email: 'hola@altioraestudio.com',
  },
};
