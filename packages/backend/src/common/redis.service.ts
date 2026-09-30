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
  private client: Redis | null = null;
  private lastError: string | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    // Redis is optional. Without REDIS_URL there is nothing to connect to:
    // falling back to localhost:6379 made ioredis retry forever on every
    // default self-hosted install and log a warning every two seconds.
    const url = this.configService.get<string>('REDIS_URL')?.trim();
    if (!url) {
      this.logger.log('REDIS_URL is not set: caching and rate-limit counters stay in memory.');
      return;
    }

    this.client = new Redis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    // Log a connection error once, not on every retry; say so when it recovers.
    this.client.on('error', (err) => {
      if (err.message === this.lastError) return;
      this.lastError = err.message;
      this.logger.warn(`Redis connection error: ${err.message}`);
    });
    this.client.on('ready', () => {
      if (this.lastError) this.logger.log('Redis connection restored');
      this.lastError = null;
    });

    try {
      await this.client.connect();
      this.logger.log('Redis connected');
    } catch (err: any) {
      this.logger.warn(`Redis not available: ${err.message}. Caching disabled until it is.`);
    }
  }

  async onModuleDestroy() {
    if (this.client?.status === 'ready') {
      await this.client.quit();
    }
  }

  /** REDIS_URL is set; the connection may still be down. */
  get isConfigured(): boolean {
    return this.client !== null;
  }

  get isConnected(): boolean {
    return this.client?.status === 'ready';
  }

  async get(key: string): Promise<string | null> {
    if (!this.isConnected) return null;
    return this.client!.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.isConnected) return;
    if (ttlSeconds) {
      await this.client!.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client!.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    if (!this.isConnected) return;
    await this.client!.del(key);
  }

  async incr(key: string): Promise<number> {
    if (!this.isConnected) return 0;
    return this.client!.incr(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    if (!this.isConnected) return;
    await this.client!.expire(key, ttlSeconds);
  }

  async ttl(key: string): Promise<number> {
    if (!this.isConnected) return -1;
    return this.client!.ttl(key);
  }

  getClient(): Redis | null {
    return this.client;
  }
}
