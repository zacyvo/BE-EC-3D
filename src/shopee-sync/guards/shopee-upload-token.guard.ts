import { CanActivate, ExecutionContext, HttpStatus, Injectable, createParamDecorator } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Request } from 'express';
import {
  ShopeeSyncSession,
  ShopeeSyncSessionDocument,
  ShopeeSyncSessionStatus,
} from '../schemas/shopee-sync-session.schema';
import { hashUploadToken } from '../shopee-sync-token.util';
import { ShopeeSyncException } from '../shopee-sync.exceptions';
import { ShopeeSyncErrorCode } from '../shopee-sync.constants';

export interface RequestWithShopeeSyncSession extends Request {
  shopeeSyncSession: ShopeeSyncSessionDocument;
}

const TERMINAL_STATUSES = new Set<ShopeeSyncSessionStatus>([
  ShopeeSyncSessionStatus.CANCELLED,
  ShopeeSyncSessionStatus.COMMITTED,
  ShopeeSyncSessionStatus.EXPIRED,
  ShopeeSyncSessionStatus.FAILED,
]);

/**
 * Authenticates the Chrome Extension's calls to the list-snapshot / per-product
 * upload endpoints. This is intentionally NOT the staff JWT guard — the extension
 * never holds an admin's credentials, only the short-lived, upload-scoped token
 * returned once by `POST /sync-sessions` (see feature spec section 10).
 */
@Injectable()
export class ShopeeUploadTokenGuard implements CanActivate {
  constructor(
    @InjectModel(ShopeeSyncSession.name)
    private readonly sessionModel: Model<ShopeeSyncSessionDocument>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithShopeeSyncSession>();
    const sessionId = request.params.id;

    if (!sessionId || !Types.ObjectId.isValid(sessionId)) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.SYNC_SESSION_NOT_FOUND,
        'Không tìm thấy phiên đồng bộ',
        HttpStatus.NOT_FOUND,
      );
    }

    const authHeader = request.headers.authorization;
    const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : null;
    if (!rawToken) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.UPLOAD_TOKEN_INVALID,
        'Thiếu upload token',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const session = await this.sessionModel.findById(sessionId).select('+uploadTokenHash').exec();
    if (!session || hashUploadToken(rawToken) !== session.uploadTokenHash) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.UPLOAD_TOKEN_INVALID,
        'Upload token không hợp lệ',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (TERMINAL_STATUSES.has(session.status)) {
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.SYNC_SESSION_INVALID_STATE,
        'Phiên đồng bộ đã kết thúc',
        HttpStatus.CONFLICT,
      );
    }

    if (session.uploadTokenExpiresAt.getTime() < Date.now()) {
      session.status = ShopeeSyncSessionStatus.EXPIRED;
      session.errorCode = ShopeeSyncErrorCode.SYNC_SESSION_EXPIRED;
      session.errorMessage = 'Upload token đã hết hạn';
      await session.save();
      throw new ShopeeSyncException(
        ShopeeSyncErrorCode.SYNC_SESSION_EXPIRED,
        'Phiên đồng bộ đã hết hạn, vui lòng bắt đầu lại',
        HttpStatus.UNAUTHORIZED,
      );
    }

    request.shopeeSyncSession = session;
    return true;
  }
}

/** Pulls the session resolved by `ShopeeUploadTokenGuard` into the controller method. */
export const UploadSession = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<RequestWithShopeeSyncSession>();
  return request.shopeeSyncSession;
});
