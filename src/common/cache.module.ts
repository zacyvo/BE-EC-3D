import { Module } from '@nestjs/common';
import { CacheModule as NestCacheModule } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { redisStore } from 'cache-manager-ioredis-yet';

@Module({
  imports: [
    NestCacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const redisUrl = configService.get<string>('REDIS_URL');
        if (redisUrl) {
          return {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            store: await redisStore({ url: redisUrl } as any),
            ttl: 300, // 5 minutes default
          };
        }
        // Fallback to in-memory cache for dev
        return { ttl: 300 };
      },
      inject: [ConfigService],
    }),
  ],
})
export class CacheModule {}
