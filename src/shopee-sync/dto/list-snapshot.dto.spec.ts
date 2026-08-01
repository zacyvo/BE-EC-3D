import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListSnapshotDto } from './list-snapshot.dto';

/** Mirrors the global ValidationPipe options set in `main.ts` (whitelist +
 * forbidNonWhitelisted) so this test proves the same guarantee the real HTTP
 * pipeline gives: an unexpected field (e.g. a Shopee session value) makes the
 * whole request fail validation instead of silently passing through. */
const VALIDATION_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

describe('ListSnapshotDto (test #22 — SPC_CDS must never reach a stored backend payload)', () => {
  const validPayload = {
    total: 2,
    items: [
      { externalProductId: '111', modifyTime: 1_700_000_000, createTime: 1_600_000_000, status: 1 },
      { externalProductId: '222', modifyTime: 1_700_000_001, createTime: 1_600_000_001, status: 1 },
    ],
  };

  it('accepts a well-formed snapshot payload', async () => {
    const dto = plainToInstance(ListSnapshotDto, validPayload);
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('rejects the whole request when a top-level SPC_CDS-like field is present', async () => {
    const dto = plainToInstance(ListSnapshotDto, { ...validPayload, spcCds: 'abc123' });
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'spcCds')).toBe(true);
  });

  it('rejects the whole request when a nested item carries an unexpected session-like field', async () => {
    const dto = plainToInstance(ListSnapshotDto, {
      total: 1,
      items: [{ externalProductId: '111', modifyTime: 1, createTime: 1, status: 1, spcCdsVer: '2' }],
    });
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-integer/empty externalProductId', async () => {
    const dto = plainToInstance(ListSnapshotDto, {
      total: 1,
      items: [{ externalProductId: '', modifyTime: 1, createTime: 1, status: 1 }],
    });
    const errors = await validate(dto, VALIDATION_OPTIONS);
    expect(errors.length).toBeGreaterThan(0);
  });
});
