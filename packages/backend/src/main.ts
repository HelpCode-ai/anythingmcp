import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { startMetricsServer, stopMetricsServer } from './common/metrics';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  
  const port = process.env.PORT || 4000;
  await app.listen(port);
  logger.log(`Application is running on: http://localhost:${port}`);

  startMetricsServer();

  const signals = ['SIGTERM', 'SIGINT'];
  for (const signal of signals) {
    process.once(signal, async () => {
      logger.log(`Received ${signal}, shutting down gracefully...`);
      await stopMetricsServer();
      await app.close();
      process.exit(0);
    });
  }
}
bootstrap();
