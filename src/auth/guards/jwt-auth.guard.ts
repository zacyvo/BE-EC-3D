import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleRequest<TUser = any>(err: Error, user: TUser): TUser {
    if (err || !user) {
      throw err || new UnauthorizedException('Invalid or expired token');
    }
    return user;
  }
}

@Injectable()
export class JwtRefreshGuard extends AuthGuard('jwt-refresh') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleRequest<TUser = any>(err: Error, user: TUser): TUser {
    if (err || !user) {
      throw err || new UnauthorizedException('Invalid refresh token');
    }
    return user;
  }
}

@Injectable()
export class JwtStaffGuard extends AuthGuard('jwt-staff') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleRequest<TUser = any>(err: Error, user: TUser): TUser {
    if (err || !user) {
      throw err || new UnauthorizedException('Staff access required');
    }
    return user;
  }
}
