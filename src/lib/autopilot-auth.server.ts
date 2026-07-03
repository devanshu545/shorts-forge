const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_AUDIENCE = "shortforge-autopilot";
const DEFAULT_GITHUB_REPOSITORY = "devanshu545/shorts-forge";
const WORKFLOW_FILES = [".github/workflows/autopilot.yml", ".github/workflows/splitter.yml"];

type GithubJwk = JsonWebKey & { kid?: string; alg?: string };
type GithubJwks = { keys?: GithubJwk[] };
type JwtHeader = { alg?: string; kid?: string };
type GithubOidcClaims = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  repository?: string;
  repository_owner?: string;
  workflow_ref?: string;
};

let jwksCache: { keys: GithubJwk[]; expiresAt: number } | undefined;

function base64UrlToBytes(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function parseJwtPart<T>(value: string): T {
  const json = new TextDecoder().decode(base64UrlToBytes(value));
  return JSON.parse(json) as T;
}

async function getGithubJwks(): Promise<GithubJwk[]> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const res = await fetch(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`);
  if (!res.ok) throw new Error(`GitHub OIDC keys unavailable: HTTP ${res.status}`);
  const body = (await res.json()) as GithubJwks;
  const keys = body.keys || [];
  jwksCache = { keys, expiresAt: Date.now() + 60 * 60 * 1000 };
  return keys;
}

function audienceMatches(aud: string | string[] | undefined) {
  return Array.isArray(aud) ? aud.includes(GITHUB_OIDC_AUDIENCE) : aud === GITHUB_OIDC_AUDIENCE;
}

function allowedRepository() {
  return (process.env.AUTOPILOT_GITHUB_REPOSITORY || DEFAULT_GITHUB_REPOSITORY).trim().toLowerCase();
}

async function verifyGithubOidcToken(token: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  const [rawHeader, rawClaims, rawSignature] = parts;
  const header = parseJwtPart<JwtHeader>(rawHeader);
  const claims = parseJwtPart<GithubOidcClaims>(rawClaims);
  if (header.alg !== "RS256" || !header.kid) return false;

  const now = Math.floor(Date.now() / 1000);
  const repo = allowedRepository();
  if (claims.iss !== GITHUB_OIDC_ISSUER) return false;
  if (!audienceMatches(claims.aud)) return false;
  if (!claims.exp || claims.exp < now - 30) return false;
  if (claims.nbf && claims.nbf > now + 30) return false;
  if ((claims.repository || "").toLowerCase() !== repo) return false;
  const wref = (claims.workflow_ref || "").toLowerCase();
  if (!WORKFLOW_FILES.some((f) => wref.startsWith(`${repo}/${f}@`))) return false;

  const jwk = (await getGithubJwks()).find((key) => key.kid === header.kid);
  if (!jwk) return false;

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(rawSignature),
    new TextEncoder().encode(`${rawHeader}.${rawClaims}`),
  );
}

export async function isAutopilotRequestAuthorized(request: Request): Promise<boolean> {
  const url = new URL(request.url);
  const providedSecret = request.headers.get("x-autopilot-secret") || url.searchParams.get("secret");
  const validSecrets = [process.env.AUTOPILOT_SECRET, process.env.AUTOPILOT_SECRET_GITHUB].filter(Boolean);
  if (providedSecret && validSecrets.includes(providedSecret)) return true;

  const auth = request.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  try {
    return await verifyGithubOidcToken(match[1]);
  } catch (err) {
    console.warn("GitHub OIDC auth failed", err);
    return false;
  }
}
