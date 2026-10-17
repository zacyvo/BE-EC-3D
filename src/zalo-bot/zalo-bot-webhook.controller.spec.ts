import { ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ZaloBotConfigService } from './zalo-bot.config';
import { ZaloBotWebhookController, parseTextReceivedEvent, secretMatches } from './zalo-bot-webhook.controller';
import { ZaloOwnerRecipientService } from './zalo-owner-recipient.service';

const SECRET = 'webhook-secret-for-tests-123';

const textEvent = (chatId: unknown = '7ab1c2d3e4f5', extra: Record<string, unknown> = {}) => ({
  ok: true,
  result: {
    event_name: 'message.text.received',
    message: {
      from: { id: 'u1', display_name: 'Chủ shop', is_bot: false },
      chat: { id: chatId, chat_type: 'PRIVATE' },
      text: 'HELLO LUXE GLOW',
      message_id: 'm1',
      date: 1750316131602,
      ...extra,
    },
  },
});

function makeController(secret = SECRET) {
  const cfg = new ZaloBotConfigService({
    get: (k: string) => (k === 'ZALO_BOT_WEBHOOK_SECRET' ? secret : undefined),
  } as unknown as ConfigService);
  const recipients = { recordInboundChat: jest.fn().mockResolvedValue('created') };
  const controller = new ZaloBotWebhookController(cfg, recipients as unknown as ZaloOwnerRecipientService);
  return { controller, recipients };
}

describe('ZaloBotWebhookController', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('TEST 15: invalid or missing secret → 403, nothing recorded', async () => {
    const { controller, recipients } = makeController();
    await expect(controller.receive('wrong-secret', textEvent())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.receive(undefined, textEvent())).rejects.toBeInstanceOf(ForbiddenException);
    expect(recipients.recordInboundChat).not.toHaveBeenCalled();
  });

  it('rejects everything when no secret is configured', async () => {
    const { controller, recipients } = makeController('');
    await expect(controller.receive('anything', textEvent())).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(recipients.recordInboundChat).not.toHaveBeenCalled();
  });

  it('TEST 16/17: valid secret → accepted and chat id extracted from result.message.chat.id', async () => {
    const { controller, recipients } = makeController();
    const res = await controller.receive(SECRET, textEvent('7ab1c2d3e4f5'));
    expect(res).toEqual({ received: true, handled: true });
    expect(recipients.recordInboundChat).toHaveBeenCalledWith({
      chatId: '7ab1c2d3e4f5',
      chatType: 'PRIVATE',
      displayName: 'Chủ shop',
    });
  });

  it('acknowledges verification probes / unsupported events without processing', async () => {
    const { controller, recipients } = makeController();
    expect(await controller.receive(SECRET, {})).toMatchObject({ received: true, handled: false });
    expect(
      await controller.receive(SECRET, { ok: true, result: { event_name: 'message.sticker.received', message: {} } }),
    ).toMatchObject({ received: true, handled: false, event: 'message.sticker.received' });
    expect(await controller.receive(SECRET, 'garbage')).toMatchObject({ handled: false });
    expect(recipients.recordInboundChat).not.toHaveBeenCalled();
  });

  it('parser: numeric chat ids are stringified; bots, empty and oversized ids ignored', () => {
    expect(parseTextReceivedEvent(textEvent(12345)).chat?.chatId).toBe('12345');
    expect(parseTextReceivedEvent(textEvent('')).chat).toBeNull();
    expect(parseTextReceivedEvent(textEvent('x'.repeat(200))).chat).toBeNull();
    expect(parseTextReceivedEvent(textEvent({ nested: true })).chat).toBeNull();
    const botEvent = textEvent('abc');
    (botEvent.result.message.from as { is_bot: boolean }).is_bot = true;
    expect(parseTextReceivedEvent(botEvent).chat).toBeNull();
  });

  it('secretMatches is exact', () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(SECRET + 'x', SECRET)).toBe(false);
    expect(secretMatches('', SECRET)).toBe(false);
    expect(secretMatches(SECRET, '')).toBe(false);
  });
});
