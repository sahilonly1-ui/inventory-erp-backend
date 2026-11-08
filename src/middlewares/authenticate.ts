import { asyncHandler } from '../common/asyncHandler';
import { UnauthorizedError } from '../common/errors';
import { verifyAccessToken } from '../utils/jwt.util';
import { prisma } from '../config/prisma';

// Verifies the access token and loads the user's live roles + permissions.
// Permissions are resolved from the DB (not the JWT) so revocations take effect
// immediately rather than waiting for token expiry.
const userCache = new Map<string, { at: number; id: string; email: string; roles: string[]; permissions: Set<string> }>();
/** Drop cached access (call after changing a user's roles). */
export const forgetUserAccess = (id?: string) => { if (id) userCache.delete(id); else userCache.clear(); };

export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing bearer token');
  }

  let payload;
  try {
    payload = verifyAccessToken(header.slice(7));
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }

  // Cached for 30 s: every request used to make several trips to a distant
  // database just to re-read the same roles. A revoked user or permission still
  // takes effect within half a minute.
  const hit = userCache.get(payload.sub);
  if (hit && hit.at > Date.now() - 30_000) {
    req.user = { id: hit.id, email: hit.email, roles: hit.roles, permissions: hit.permissions };
    return next();
  }
  const user = await prisma.user.findFirst({
    where: { id: payload.sub, isDeleted: false, isActive: true },
    include: { roles: { include: { permissions: true } } },
  });
  if (!user) { userCache.delete(payload.sub); throw new UnauthorizedError('User no longer active'); }

  const permissions = new Set<string>();
  const roles: string[] = [];
  for (const role of user.roles) {
    roles.push(role.name);
    for (const perm of role.permissions) permissions.add(perm.code);
  }

  userCache.set(user.id, { at: Date.now(), id: user.id, email: user.email, roles, permissions });
  req.user = { id: user.id, email: user.email, roles, permissions };
  next();
});
