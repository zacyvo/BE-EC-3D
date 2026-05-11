import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { ResponseInterceptor } from './common/response.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const configService = app.get(ConfigService);

  const port = Number(configService.get<string>('PORT') || 3001);

  const frontendUrl = configService.get<string>(
    'FRONTEND_URL',
    'http://localhost:3000',
  );

  const adminUrl = configService.get<string>(
    'ADMIN_URL',
    'http://localhost:3002',
  );

  app.use(helmet());

  app.enableCors({
    origin: [
      'http://localhost:3000',
      'https://web-ec-3-d.vercel.app',
      'https://luxe-glow.vn',
      'https://www.luxe-glow.vn',
      'https://admin.luxe-glow.vn',
      'https://admin-3-d-web.vercel.app',
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  if (configService.get('NODE_ENV') !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('WEB-EC-3D API')
      .setDescription('3D Lamp E-Commerce API Documentation')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(port, '0.0.0.0');

  console.log(`🚀 Server running on port ${port}`);
}

bootstrap();