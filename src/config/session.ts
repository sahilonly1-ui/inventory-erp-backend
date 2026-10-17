/**
 * How long a login lasts.
 *
 * These were environment variables, and that is why they did not work: the
 * deploy workflow only writes env vars when it CREATES the Render service. The
 * service already existed, so every deploy just redeployed it and the live
 * values stayed at their original 15 minutes and 7 days — changing the
 * workflow, or the defaults in env.ts, had no effect at all.
 *
 * They are a product decision rather than a deployment secret (people stay
 * signed in until they sign out), so they live here in code, where what is
 * written is what runs.
 *
 * The access token is short-lived by nature but is renewed quietly, and the
 * user's active status is checked on every request, so deactivating someone
 * still takes effect immediately regardless of how long this is.
 */
export const ACCESS_TOKEN_TTL = '12h';
export const REFRESH_TOKEN_TTL_DAYS = 90;
