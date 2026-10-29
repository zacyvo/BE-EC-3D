import { ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ALLOW_SHOPEE_REVIEWER_KEY, ROLES_KEY, StaffRole } from '../decorators/roles.decorator';

/**
 * SHOPEE_REVIEWER is deny-by-default on every authenticated route — enforced here, in the
 * guards that authenticate the token, so it also covers routes with no RolesGuard, routes
 * whose `@Roles()` is empty ("any staff"), and customer routes (the customer `jwt` strategy
 * accepts staff tokens too). It passes only where a route explicitly opts in.
 */
export function assertShopeeReviewerAllowed(reflector: Reflector, context: ExecutionContext, user: unknown): void {
  if ((user as { role?: string } | null)?.role !== StaffRole.SHOPEE_REVIEWER) return;
  const targets = [context.getHandler(), context.getClass()];
  const roles = reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES_KEY, targets);
  const optedIn = reflector.getAllAndOverride<boolean | undefined>(ALLOW_SHOPEE_REVIEWER_KEY, targets);
  if (optedIn || roles?.includes(StaffRole.SHOPEE_REVIEWER)) return;
  throw new ForbiddenException('Tài khoản kiểm duyệt Shopee không có quyền truy cập chức năng này');
}

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleRequest<TUser = any>(err: Error, user: TUser, _info: unknown, context: ExecutionContext): TUser {
    if (err || !user) {
      throw err || new UnauthorizedException('Invalid or expired token');
    }
    assertShopeeReviewerAllowed(this.reflector, context, user);
    return user;
  }
}

@Injectable()
export class JwtRefreshGuard extends AuthGuard('jwt-refresh') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleRequest<TUser = any>(err: Error, user: TUser, _info: unknown, context: ExecutionContext): TUser {
    if (err || !user) {
      throw err || new UnauthorizedException('Invalid refresh token');
    }
    assertShopeeReviewerAllowed(this.reflector, context, user);
    return user;
  }
}

@Injectable()
export class JwtStaffGuard extends AuthGuard('jwt-staff') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleRequest<TUser = any>(err: Error, user: TUser, _info: unknown, context: ExecutionContext): TUser {
    if (err || !user) {
      throw err || new UnauthorizedException('Staff access required');
    }
    assertShopeeReviewerAllowed(this.reflector, context, user);
    return user;
  }
}
