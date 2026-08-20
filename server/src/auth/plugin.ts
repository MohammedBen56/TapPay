import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config, type JwtSigningKey } from "../config.js";

/** Access-token claims (docs/TapPay_v2_Technical_Design.md §6). `sub` is
 * accounts.user_id -- the same join key devices/customer_credentials/
 * beneficiaries already key off of -- not account_id, so a future
 * multi-account-per-customer model wouldn't need to re-mint every token
 * shape. */
export interface AccessTokenPayload {
  sub: string;
  aid: string;
  cid: string;
  /** Ship List v2 Wave 2 Phase 4: set only on a short-lived step-up token
   * (POST /auth/step-up), never on an ordinary access token. Proves "the
   * password was just re-entered" for one specific follow-up call (e.g. a
   * large POST /transfers) -- NOT "this caller may act as this user
   * generally". app.authenticate below rejects any token carrying this,
   * so a step-up token can never substitute as a bearer credential on any
   * other authenticated route. */
  typ?: "step_up";
  /** Ship List v2 Wave 2 Phase 4: set only alongside typ: "step_up",
   * binding the token to the ONE tx_uuid it was requested for. Without
   * this, a single step-up token (one real password re-entry) stays valid
   * for its whole TTL and could be replayed across many separate large
   * transfers -- found by /security-review as a real gap against this
   * field's own "proves presence for one specific follow-up call" intent.
   * routes/transfers.ts's verifyStepUpToken checks this against the
   * transfer's own tx_uuid; a resubmission of that SAME tx_uuid is a
   * legitimate idempotent replay (CLAUDE.md §5), so re-presenting the same
   * step-up token for it is correct, not a gap. */
  tx_uuid?: string;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AccessTokenPayload;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/** By kid, for O(1) lookup on every verify -- config.jwtSigningKeys is a
 * short, rarely-changing array (one active key plus, during a rotation's
 * overlap window, a handful of still-valid-for-verification-only prior
 * ones), so this is built once at module load rather than searched linearly
 * per request. */
const signingKeysByKid = new Map<string, JwtSigningKey>(config.jwtSigningKeys.map((key) => [key.kid, key]));
const currentSigningKey = config.jwtSigningKeys[0]!; // parseJwtSigningKeys always returns at least one

/** Resolves the secret for both signing and verifying, keyed on the JWT's
 * own `kid` header -- this is what makes JWT_SECRET rotation possible
 * without invalidating every outstanding access token the moment a new key
 * is promoted (see config.ts's parseJwtSigningKeys doc comment for the
 * rotation runbook). Signing always uses the current key regardless of what
 * `kid` @fastify/jwt asks for here (routes/auth.ts's signAccessToken sets
 * `kid` explicitly in the sign options to match); verifying looks up
 * whichever key the presented token was actually signed with, including a
 * key that's since been rotated out of active signing but is still within
 * its overlap window. An unknown kid is a hard failure, not a silent
 * fallback to the current key -- accepting an unrecognized kid would defeat
 * the entire point of keying by kid in the first place. */
// Deliberately structural rather than importing @fastify/jwt's own
// TokenOrHeader type: the package's `export =` + merged-namespace shape
// isn't reachable as a type through a default import under this project's
// module settings, and the two fields this function actually reads
// (a bare header, or `{ header }`) are simple enough not to need it.
type SecretResolverInput = { kid?: unknown } | { header: { kid?: unknown } };

function resolveSecret(_request: FastifyRequest, tokenOrHeader: SecretResolverInput): Promise<string> {
  const header = "header" in tokenOrHeader ? tokenOrHeader.header : tokenOrHeader;
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  if (kid === undefined) {
    // Signing: @fastify/jwt/fast-jwt calls the resolver with whatever
    // header fields the caller already set. signAccessToken always passes
    // `kid` explicitly, so an undefined kid here only happens for a token
    // being verified that was never signed by this server at all.
    return Promise.resolve(currentSigningKey.secret);
  }
  const key = signingKeysByKid.get(kid);
  if (!key) return Promise.reject(new Error(`unknown JWT kid: ${kid}`));
  return Promise.resolve(key.secret);
}

/** Registers @fastify/jwt and decorates `app.authenticate`, a preHandler
 * routes opt into individually (`{ preHandler: [app.authenticate] }`) --
 * deliberately NOT a global onRequest hook, so `/health` and `/auth/*` are
 * open by construction rather than by an exception list some future route
 * has to remember to add itself to.
 *
 * Unlike @fastify/rate-limit (see the .after() comment elsewhere in app.ts),
 * this needs no special registration-order sequencing: nothing here reads an
 * onRoute hook at declaration time, so being registered before or after the
 * routes below is equivalent -- request.jwtVerify() and app.jwt.sign() are
 * only ever called inside a request handler, well after the whole plugin
 * tree has finished booting (app.ready()). */
export function registerAuthPlugin(app: FastifyInstance): void {
  // decode.complete: true is what makes @fastify/jwt pass the FULL decoded
  // token ({header, payload, signature}) to the secret resolver above,
  // rather than just the payload -- without it, resolveSecret has no way to
  // read the kid header at all (confirmed by direct reproduction: every
  // verify call received a bare payload object, no kid, until this was
  // added). This only affects what the resolver itself sees; the shape of
  // request.user after a successful verify is controlled by the separate
  // `verify` options below and is unchanged.
  app.register(fastifyJwt, { secret: resolveSecret, decode: { complete: true } });

  app.decorate("authenticate", async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
      // Fail closed: a step-up token is intentionally a narrower
      // credential than a real access token (see AccessTokenPayload's
      // `typ` doc comment) -- accepting it here would let a captured
      // step-up token act as a full bearer credential everywhere, the
      // opposite of what it's meant to prove.
      if (request.user.typ === "step_up") {
        throw new Error("step-up token used as a bearer credential");
      }
    } catch {
      reply.status(401).send({ error: "Unauthorized", message: "missing or invalid access token" });
    }
  });
}
