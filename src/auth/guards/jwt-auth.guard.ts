import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err: Error, user: unknown) {
    if (err || !user) {
      throw err || new UnauthorizedException('Invalid or expired token');
    }
    return user;
  }
}

@Injectable()
export class JwtRefreshGuard extends AuthGuard('jwt-refresh') {
  handleRequest(err: Error, user: unknown) {
    if (err || !user) {
      throw err || new UnauthorizedException('Invalid refresh token');
    }
    return user;
  }
}

@Injectable()
export class JwtStaffGuard extends AuthGuard('jwt-staff') {
  handleRequest(err: Error, user: unknown) {
    if (err || !user) {
      throw err || new UnauthorizedException('Staff access required');
    }
    return user;
  }
}
