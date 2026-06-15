-- Add OAUTH1 to AuthType enum.
-- ImmobilienScout24 (and other legacy APIs) require OAuth 1.0a HMAC-SHA1 request
-- signing, which is incompatible with the OAUTH2 (Bearer token) auth type.
ALTER TYPE "AuthType" ADD VALUE 'OAUTH1';
