import 'express';

declare global {
  namespace Express {
    interface UserContext {
      id: string;
      email: string;
      roles: string[];
      permissions: Set<string>;
    }
    interface Request {
      user?: UserContext;
    }
  }
}

export {};
