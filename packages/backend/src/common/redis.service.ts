import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const url = this.configService.get<string>('REDIS_URL', 'redis://localhost:6379');
    this.client = new Redis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    this.client.on('error', (err) => {
      this.logger.warn(`Redis connection error: ${err.message}`);
    });

    try {
      await this.client.connect();
      this.logger.log('Redis connected');
    } catch (err: any) {
      this.logger.warn(`Redis not available: ${err.message}. Caching disabled.`);
    }
  }

  async onModuleDestroy() {
    if (this.client?.status === 'ready') {
      await this.client.quit();
    }
  }

  get isConnected(): boolean {
    return this.client?.status === 'ready';
  }

  async get(key: string): Promise<string | null> {
    if (!this.isConnected) return null;
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.isConnected) return;
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    if (!this.isConnected) return;
    await this.client.del(key);
  }

  async incr(key: string): Promise<number> {
    if (!this.isConnected) return 0;
    return this.client.incr(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    if (!this.isConnected) return;
    await this.client.expire(key, ttlSeconds);
  }

  async ttl(key: string): Promise<number> {
    if (!this.isConnected) return -1;
    return this.client.ttl(key);
  }

  getClient(): Redis {
    return this.client;
  }
}
