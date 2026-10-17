import * as dotenv from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { ZaloBotConfigService } from '../zalo-bot.config';
import { ZaloBotClient } from '../zalo-bot.client';

dotenv.config();

/**
 * Operator CLI for the Zalo Bot activation steps — reads ZALO_BOT_* from .env / the shell,
 * never prints the token. Same plain-script style as src/seed/seed.ts (no Nest DI, no DB).
 *
 *   npm run zalo-bot -- validate          # local config check only (no network)
 *   npm run zalo-bot -- getMe             # STEP C: token + connectivity
 *   npm run zalo-bot -- getWebhookInfo
 *   npm run zalo-bot -- testWebhook       # STEP F: is our endpoint reachable from Zalo?
 *   npm run zalo-bot -- setWebhook --confirm   # STEP E: registers ZALO_BOT_WEBHOOK_URL + secret
 *
 * setWebhook overwrites whatever webhook is currently registered, so it refuses to run
 * without --confirm. There is intentionally no deleteWebhook / getUpdates command.
 */
async function main() {
  const [command, ...flags] = process.argv.slice(2);
  const configService = new ZaloBotConfigService(new ConfigService(process.env));
  const client = new ZaloBotClient(configService);
  const cfg = configService.get();

  const print = (label: string, value: unknown) => console.log(`${label}:`, JSON.stringify(value, null, 2));

  switch (command) {
    case 'validate': {
      print('readiness', configService.readiness());
      return;
    }
    case 'getMe':
      print('getMe', await client.getMe());
      return;
    case 'getWebhookInfo':
      print('getWebhookInfo', await client.getWebhookInfo());
      return;
    case 'testWebhook': {
      const res = await client.testWebhook();
      print('testWebhook', res);
      if (res.ok) {
        const reachable = res.result?.ok === true && res.result?.outcome === 'webhook.ok';
        console.log(reachable ? '✅ Webhook reachable (webhook.ok)' : `❌ Webhook NOT reachable: ${res.result?.outcome} — ${res.result?.hint ?? ''}`);
      }
      return;
    }
    case 'setWebhook': {
      if (!flags.includes('--confirm')) {
        console.error('Refusing: setWebhook replaces the currently registered webhook. Re-run with --confirm.');
        process.exitCode = 1;
        return;
      }
      if (!cfg.webhookUrl || !cfg.webhookSecret) {
        console.error('ZALO_BOT_WEBHOOK_URL and ZALO_BOT_WEBHOOK_SECRET must both be set.');
        process.exitCode = 1;
        return;
      }
      console.log(`Registering webhook → ${cfg.webhookUrl}`);
      print('setWebhook', await client.setWebhook(cfg.webhookUrl, cfg.webhookSecret));
      return;
    }
    default:
      console.log('Usage: npm run zalo-bot -- <validate|getMe|getWebhookInfo|testWebhook|setWebhook --confirm>');
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((err) => {
  console.error('❌', (err as Error).message);
  process.exit(1);
});
