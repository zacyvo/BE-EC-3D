import { SetMetadata } from '@nestjs/common';

export enum StaffRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN = 'ADMIN',
  CS = 'CS',
  SELLER = 'SELLER',
  /**
   * External reviewer account (Shopee Open Platform app review). DENY BY DEFAULT: the JWT
   * guards reject it on every route unless the route lists it in `@Roles(...)` or carries
   * `@AllowShopeeReviewer()` — an empty/absent `@Roles` ("any staff") does NOT include it.
   * See auth/guards/jwt-auth.guard.ts and auth/shopee-reviewer-access.spec.ts.
   */
  SHOPEE_REVIEWER = 'SHOPEE_REVIEWER',
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);

export const ALLOW_SHOPEE_REVIEWER_KEY = 'allowShopeeReviewer';
/** Opens an "any staff" route (self-service: me, profile, password, logout) to SHOPEE_REVIEWER. */
export const AllowShopeeReviewer = () => SetMetadata(ALLOW_SHOPEE_REVIEWER_KEY, true);
