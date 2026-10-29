import 'reflect-metadata';
import { Controller, ExecutionContext, ForbiddenException, Get, INestApplication, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { JwtStaffStrategy, JwtStrategy } from './strategies/jwt.strategy';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA, METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AppModule } from '../app.module';
import { assertShopeeReviewerAllowed, JwtAuthGuard, JwtRefreshGuard, JwtStaffGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { ALLOW_SHOPEE_REVIEWER_KEY, AllowShopeeReviewer, ROLES_KEY, Roles, StaffRole } from './decorators/roles.decorator';

/**
 * SHOPEE_REVIEWER is an EXTERNAL account (Shopee app review) on production. This test walks
 * every controller registered under AppModule and pins the exact set of routes it can reach.
 * Adding a route that leaks to it (or removing one it needs) fails here — update the list
 * below only after deciding the new route exposes no customer/business data.
 */
const EXPECTED_REVIEWER_ROUTES = [
  'GET /admin/integrations/shopee/config',
  'GET /admin/integrations/shopee/sync-sessions/latest',
  'GET /admin/integrations/shopee/sync-sessions/:id',
  'GET /admin/integrations/shopee/open-api/status',
  'GET /admin/integrations/shopee/orders/batches',
  'GET /admin/integrations/shopee/orders/batches/:id',
  'GET /admin/staff/me',
  'PATCH /admin/staff/me/profile',
  'PATCH /admin/staff/me/password',
  'POST /auth/staff/logout',
].sort();

const JWT_GUARDS = new Set<unknown>([JwtAuthGuard, JwtStaffGuard, JwtRefreshGuard]);
type Ctor = new (...args: never[]) => unknown;

function collectControllers(root: unknown): Ctor[] {
  const seen = new Set<unknown>();
  const controllers = new Set<Ctor>();
  const visit = (m: unknown) => {
    if (!m) return;
    const ref = m as { forwardRef?: () => unknown; module?: unknown; imports?: unknown[]; controllers?: Ctor[] };
    if (typeof ref.forwardRef === 'function') return visit(ref.forwardRef());
    if (seen.has(m)) return;
    seen.add(m);
    if (typeof m === 'function') {
      (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, m) ?? []).forEach((c: Ctor) => controllers.add(c));
      (Reflect.getMetadata(MODULE_METADATA.IMPORTS, m) ?? []).forEach(visit);
    } else if (ref.module) {
      (ref.controllers ?? []).forEach((c) => controllers.add(c));
      (ref.imports ?? []).forEach(visit);
      visit(ref.module);
    }
  };
  visit(root);
  return Array.from(controllers);
}

function joinPath(...parts: (string | string[] | undefined)[]): string {
  const segs = parts.flatMap((p) => (Array.isArray(p) ? p[0] : p) ?? '').join('/');
  return '/' + segs.split('/').filter(Boolean).join('/');
}

let scannedJwtRoutes = 0;

function reviewerReachableRoutes(): string[] {
  const reflector = new Reflector();
  const reachable: string[] = [];
  scannedJwtRoutes = 0;
  for (const controller of collectControllers(AppModule)) {
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler);
      if (path === undefined) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
      const route = `${method} ${joinPath(Reflect.getMetadata(PATH_METADATA, controller), path)}`;

      const guards = [...(Reflect.getMetadata(GUARDS_METADATA, controller) ?? []), ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? [])];
      if (!guards.some((g) => JWT_GUARDS.has(g))) continue; // public (or non-JWT) route — not this test's concern
      scannedJwtRoutes += 1;

      const roles = reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES_KEY, [handler, controller]);
      const optIn = reflector.getAllAndOverride<boolean | undefined>(ALLOW_SHOPEE_REVIEWER_KEY, [handler, controller]);
      const passesJwtGuard = !!optIn || !!roles?.includes(StaffRole.SHOPEE_REVIEWER);
      const passesRolesGuard =
        !guards.includes(RolesGuard) || !roles || roles.length === 0 || roles.includes(StaffRole.SHOPEE_REVIEWER);
      if (passesJwtGuard && passesRolesGuard) reachable.push(route);
    }
  }
  return reachable.sort();
}

describe('SHOPEE_REVIEWER access (deny by default)', () => {
  it('can reach exactly the allowlisted routes across the whole app', () => {
    expect(reviewerReachableRoutes()).toEqual(EXPECTED_REVIEWER_ROUTES);
    // Guard against a scan that silently finds nothing (the allowlist alone would then be meaningless).
    expect(scannedJwtRoutes).toBeGreaterThan(150);
  });

  it('the review queue (recipient data) and every write stays closed', () => {
    const routes = reviewerReachableRoutes();
    expect(routes.some((r) => r.includes('/orders/issues'))).toBe(false);
    expect(routes.filter((r) => !r.startsWith('GET ')).every((r) => /staff\/me|staff\/logout/.test(r))).toBe(true);
  });

  describe('assertShopeeReviewerAllowed', () => {
    const reflector = new Reflector();
    class C {
      open() {}
      anyStaff() {}
      listed() {}
      optedIn() {}
    }
    Reflect.defineMetadata(ROLES_KEY, [], C.prototype.anyStaff);
    Reflect.defineMetadata(ROLES_KEY, [StaffRole.ADMIN, StaffRole.SHOPEE_REVIEWER], C.prototype.listed);
    Reflect.defineMetadata(ALLOW_SHOPEE_REVIEWER_KEY, true, C.prototype.optedIn);
    const ctx = (fn: () => void) => ({ getHandler: () => fn, getClass: () => C }) as unknown as ExecutionContext;
    const reviewer = { sub: 'x', type: 'staff', role: StaffRole.SHOPEE_REVIEWER };

    it('blocks routes with no roles and "any staff" routes', () => {
      expect(() => assertShopeeReviewerAllowed(reflector, ctx(C.prototype.open), reviewer)).toThrow(ForbiddenException);
      expect(() => assertShopeeReviewerAllowed(reflector, ctx(C.prototype.anyStaff), reviewer)).toThrow(ForbiddenException);
    });

    it('allows routes that list the role or opt in', () => {
      expect(() => assertShopeeReviewerAllowed(reflector, ctx(C.prototype.listed), reviewer)).not.toThrow();
      expect(() => assertShopeeReviewerAllowed(reflector, ctx(C.prototype.optedIn), reviewer)).not.toThrow();
    });

    it('never affects other roles or customers', () => {
      expect(() => assertShopeeReviewerAllowed(reflector, ctx(C.prototype.open), { role: StaffRole.CS })).not.toThrow();
      expect(() => assertShopeeReviewerAllowed(reflector, ctx(C.prototype.open), { sub: 'u', type: 'user' })).not.toThrow();
    });
  });
});

/** The real guards over real HTTP: passport strategy → handleRequest(context) → Reflector (DI). */
describe('SHOPEE_REVIEWER over HTTP', () => {
  @Controller('t')
  class ProbeController {
    @Get('any-staff')
    @UseGuards(JwtStaffGuard, RolesGuard)
    @Roles()
    anyStaff() {
      return 'ok';
    }

    @Get('no-roles-guard')
    @UseGuards(JwtStaffGuard)
    noRolesGuard() {
      return 'ok';
    }

    @Get('listed')
    @UseGuards(JwtStaffGuard, RolesGuard)
    @Roles(StaffRole.ADMIN, StaffRole.SHOPEE_REVIEWER)
    listed() {
      return 'ok';
    }

    @Get('self')
    @UseGuards(JwtStaffGuard, RolesGuard)
    @Roles()
    @AllowShopeeReviewer()
    self() {
      return 'ok';
    }

    @Get('customer')
    @UseGuards(JwtAuthGuard)
    customer() {
      return 'ok';
    }
  }

  const SECRET = 'reviewer-test-secret';
  let app: INestApplication;
  let base: string;
  let jwt: JwtService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret: SECRET })],
      controllers: [ProbeController],
      providers: [JwtStrategy, JwtStaffStrategy, { provide: ConfigService, useValue: { get: () => SECRET } }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => app?.close());

  const call = async (path: string, role: StaffRole) => {
    const token = jwt.sign({ sub: 'staff-1', email: 'r@x.vn', type: 'staff', role });
    return (await fetch(`${base}/t/${path}`, { headers: { Authorization: `Bearer ${token}` } })).status;
  };

  it('reviewer: 403 on "any staff", guard-only and customer routes; 200 where opted in', async () => {
    expect(await call('any-staff', StaffRole.SHOPEE_REVIEWER)).toBe(403);
    expect(await call('no-roles-guard', StaffRole.SHOPEE_REVIEWER)).toBe(403);
    expect(await call('customer', StaffRole.SHOPEE_REVIEWER)).toBe(403);
    expect(await call('listed', StaffRole.SHOPEE_REVIEWER)).toBe(200);
    expect(await call('self', StaffRole.SHOPEE_REVIEWER)).toBe(200);
  });

  it('other staff roles are unchanged', async () => {
    expect(await call('any-staff', StaffRole.CS)).toBe(200);
    expect(await call('no-roles-guard', StaffRole.SELLER)).toBe(200);
    expect(await call('listed', StaffRole.ADMIN)).toBe(200);
    expect(await call('listed', StaffRole.CS)).toBe(403);
  });
});
