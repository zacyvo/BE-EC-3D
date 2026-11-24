import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * ThrottlerGuard keyed on the browser's IP. The API runs behind Render's proxy without
 * `trust proxy`, so `req.ip` is the proxy — the stock guard would put every customer in ONE
 * bucket and a busy minute would block real checkouts. The first X-Forwarded-For hop can be
 * forged, so this only slows naive scripts down; it never stands in for an authorization check.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const forwarded = req.headers?.['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    return first || req.ip || 'unknown';
  }
}
