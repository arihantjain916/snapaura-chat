import { NextFunction, Request, Response } from "express";
import { AuthUser, resolveUserFromToken } from "../userService";

export interface AuthenticatedRequest extends Request {
  user: AuthUser;
}

export const protect = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ message: "Not authorized, no token" });
    return;
  }

  const token = header.slice("Bearer ".length).trim();

  try {
    (req as AuthenticatedRequest).user = await resolveUserFromToken(token);
    next();
  } catch (error: any) {
    // Logged rather than returned: the message can name the upstream host.
    console.error("[auth] rejected token:", error?.message ?? error);
    res.status(401).json({ message: "Not authorized, token failed" });
  }
};
