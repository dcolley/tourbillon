/**
 * #299 S299-S2: the OAuth token shape shared by the vault encrypt/decrypt helpers.
 * Previously declared in packages/db/src/schema/vault-secrets.ts, which forced
 * @tourbillon/shared to import @tourbillon/db (the db↔shared workspace cycle). The
 * interface is byte-identical; the db package's schema entry point re-exports it from
 * here, so existing type consumers importing it from the db side are unaffected.
 * Pure type — nothing here touches the DB layer.
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}
