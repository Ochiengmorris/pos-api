import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from './app.setup';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);

  const docsEnabled =
    process.env.NODE_ENV !== 'production' || process.env.ENABLE_DOCS === 'true';

  // Swagger UI needs inline scripts, so relax CSP only when docs are on (this API serves JSON only)
  app.use(helmet({ contentSecurityPolicy: docsEnabled ? false : undefined }));
  // Behind nginx / a load balancer: needed so rate limiting sees the real client IP
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

  app.enableCors({
    origin: (process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim()),
    credentials: true,
  });
  app.enableShutdownHooks();

  if (docsEnabled) {
    const config = new DocumentBuilder()
      .setTitle('POS API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  }

  await app.listen(process.env.PORT ?? 4000);
}
bootstrap();
