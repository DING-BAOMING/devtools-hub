// Admin auth for the moderation endpoints (/api/feedback PATCH+DELETE, /api/comments POST bypass + DELETE).
//
// There is deliberately NO hardcoded fallback secret. A previous `env.FEEDBACK_ADMIN_SECRET ||
// <a literal>` published a working admin key in source: on production the env binding never
// reached the Function, so the literal was the *effective* secret and anyone reading the repo
// could mark or permanently delete feedback, delete comments, and bypass the
// 3-comments/min rate limit to post unmoderated spam (comments are written with
// `approved: true`) to all 346 tools.
//
// NOTE: `libs/` is publicly served (GET /libs/<file>.js returns 200 with the full source), so
// keep this comment free of any secret value — including an already-rotated one. A leak scan
// that flags your own file is a leak scan people learn to ignore.
//
// Fail closed: if FEEDBACK_ADMIN_SECRET is not bound, NOTHING authenticates. A missing
// secret must lock the moderation endpoints, never silently re-open them.
// ponytail: plain string compare. Constant-time compare is not warranted for a secret
// that is only ever sent by our own automation over HTTPS.
export function isAdmin(context, searchParams) {
  const expected = context.env.FEEDBACK_ADMIN_SECRET;
  const given = searchParams.get('admin_secret');
  return Boolean(expected) && Boolean(given) && given === expected;
}
