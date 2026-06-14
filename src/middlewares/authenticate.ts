import { asyncHandler } from '../common/asyncHandler';
import { UnauthorizedError } from '../common/errors';
import { verifyAccessToken } from '../utils/jwt.util';
import { prisma } from '../config/prisma';

// Verifies the access token and loads the user's live roles + permissions.
// Permissions are resolved from the DB (not the JWT) so revocations take effect
// immediately rather than waiting for token expiry.
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

  const user = await prisma.user.findFirst({
    where: { id: payload.sub, isDeleted: false, isActive: true },
    include: { roles: { include: { permissions: true } } },
  });
  if (!user) throw new UnauthorizedError('User no longer active');

  const permissions = new Set<string>();
  const roles: string[] = [];
  for (const role of user.roles) {
    roles.push(role.name);
    for (const perm of role.permissions) permissions.add(perm.code);
  }

  req.user = { id: user.id, email: user.email, roles, permissions };
  next();
});
