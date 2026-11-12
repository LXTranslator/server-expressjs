/**
 * The shapes every sign in provider adapter speaks.
 */

/** What an authorization code is exchanged with. */
interface CodeExchange {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  codeVerifier: string | null;
}

/** The identity behind an access token. */
interface ProviderIdentity {
  providerUserId: string;
  username: string | null;
  email: string | null;
}

/** What every sign in provider adapter offers. */
interface OauthProvider {
  name: string;
  label: string;
  authorizeUrl: string;
  scope: string;
  supportsPkce: boolean;
  pkceMethod: string;
  requiresNetwork: boolean;
  exchangeCode(params: CodeExchange): Promise<string>;
  readIdentity(accessToken: string): Promise<ProviderIdentity>;
}

export type { CodeExchange, ProviderIdentity, OauthProvider };
