import type { Response } from "express";

/**
 * The one place an HTTP response is shaped, mirroring the Laravel API's
 * App\Http\Responses\ApiResponse exactly.
 *
 * This service used to answer in three envelopes — a bare { message }, a
 * { status: boolean, ... } and a { success: boolean, ... } — so a client had
 * to know which route it had called. Laravel had the same problem and was
 * normalised onto this shape; both services now speak it.
 *
 *   success: { isSuccess: true,  message: string|null, data?: unknown, meta?: object }
 *   failure: { isSuccess: false, message: string,      error: unknown|null }
 *
 * `data` and `meta` are omitted when absent; `error` is always present on a
 * failure so a client can read it without checking first.
 */
export interface ApiEnvelope<T = unknown> {
  isSuccess: boolean;
  message: string | null;
  data?: T;
  meta?: Record<string, unknown>;
  error?: unknown;
}

export function sendSuccess<T>(
  res: Response,
  data?: T,
  message: string | null = null,
  meta?: Record<string, unknown>,
  status = 200,
): void {
  const payload: ApiEnvelope<T> = { isSuccess: true, message };

  if (data !== undefined && data !== null) {
    payload.data = data;
  }

  if (meta !== undefined) {
    payload.meta = meta;
  }

  res.status(status).json(payload);
}

/**
 * @param error Machine-readable detail — a field-keyed map for a validation
 *              failure, null when the message says it all.
 */
export function sendError(
  res: Response,
  message: string,
  status = 400,
  error: unknown = null,
): void {
  const payload: ApiEnvelope = { isSuccess: false, message, error };

  res.status(status).json(payload);
}
