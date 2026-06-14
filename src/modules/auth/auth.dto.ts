export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface AuthUserView {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  permissions: string[];
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult extends TokenPair {
  user: Pick<AuthUserView, 'id' | 'email' | 'fullName'>;
}
