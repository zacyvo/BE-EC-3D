import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

function makeHost(url = '/api/v1/test') {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status };
  const request = { url };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('HttpExceptionFilter', () => {
  const filter = new HttpExceptionFilter();

  it('omits errorCode for a plain HttpException (backward compatible with every existing module)', () => {
    const { host, status, json } = makeHost();
    filter.catch(new HttpException('Not found', HttpStatus.NOT_FOUND), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    const body = json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.message).toBe('Not found');
    expect(body.errorCode).toBeUndefined();
  });

  it('passes through a machine-readable errorCode when the exception response provides one (ShopeeSyncException shape)', () => {
    const { host, json } = makeHost();
    filter.catch(
      new HttpException({ message: 'Phiên đồng bộ đã hết hạn', errorCode: 'SYNC_SESSION_EXPIRED' }, HttpStatus.UNAUTHORIZED),
      host,
    );

    const body = json.mock.calls[0][0];
    expect(body.errorCode).toBe('SYNC_SESSION_EXPIRED');
    expect(body.message).toBe('Phiên đồng bộ đã hết hạn');
  });

  it('still aggregates class-validator array messages into `errors` + a generic message', () => {
    const { host, json } = makeHost();
    filter.catch(new HttpException({ message: ['field a is required', 'field b is required'] }, HttpStatus.BAD_REQUEST), host);

    const body = json.mock.calls[0][0];
    expect(body.message).toBe('Validation failed');
    expect(body.errors).toEqual(['field a is required', 'field b is required']);
    expect(body.errorCode).toBeUndefined();
  });
});
