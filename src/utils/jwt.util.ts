import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessPayload {
  sub: string;
  email: string;
}

export function signAccessToken(payload: AccessPayload): string {
  const opts: jwt.SignOptions = { algorithm: 'HS256', expiresIn: env.JWT_ACCESS_TTL as never };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, opts);
}

export function verifyAccessToken(token: string): AccessPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload;
  return { sub: String(decoded.sub), email: String(decoded.email) };
}
