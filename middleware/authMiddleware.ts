import { NextFunction, Request, Response } from "express";
import { sendError } from "../apiResponse";
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
    sendError(res, "Not authorized, no token", 401);
    return;
  }

  const token = header.slice("Bearer ".length).trim();

  try {
    (req as AuthenticatedRequest).user = await resolveUserFromToken(token);
    next();
  } catch (error: any) {
    // Logged rather than returned: the message can name the upstream host.
    console.error("[auth] rejected token:", error?.message ?? error);
    sendError(res, "Not authorized, token failed", 401);
  }
};
