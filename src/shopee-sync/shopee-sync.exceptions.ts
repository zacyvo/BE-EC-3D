import { HttpException, HttpStatus } from '@nestjs/common';
import { ShopeeSyncErrorCode } from './shopee-sync.constants';

/**
 * HttpException whose response body always carries a machine-readable `errorCode`
 * (from `ShopeeSyncErrorCode`) alongside the human message, so the Admin UI /
 * Extension can branch on `errorCode` instead of parsing free text. Requires the
 * matching `errorCode` passthrough in `common/http-exception.filter.ts`.
 */
export class ShopeeSyncException extends HttpException {
  constructor(
    public readonly errorCode: ShopeeSyncErrorCode,
    message: string,
    // Plain `number` (not `HttpStatus`) so callers can also pass codes this
    // @nestjs/common version's `HttpStatus` enum doesn't define (e.g. 426).
    status: number = HttpStatus.BAD_REQUEST,
  ) {
    super({ message, errorCode }, status);
  }
}
