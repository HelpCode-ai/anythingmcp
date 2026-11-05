import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { KgController } from './kg.controller';

/** PUT /api/knowledge-graph/settings validates its body like every other DTO. */
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const metatype = Reflect.getMetadata('design:paramtypes', KgController.prototype, 'setSettings')[1];
const validate = (body: unknown) => pipe.transform(body, { type: 'body', metatype, data: '' });

describe('PUT knowledge-graph/settings body', () => {
  it('accepts a partial set of boolean switches', async () => {
    await expect(validate({ captureIntent: true, edgeAutoApply: false })).resolves.toMatchObject({
      captureIntent: true,
      edgeAutoApply: false,
    });
  });

  it('refuses a non-boolean value instead of ignoring it', async () => {
    await expect(validate({ enabled: 'yes' })).rejects.toThrow();
  });

  it('refuses unknown keys such as the read-only llmAvailable', async () => {
    await expect(validate({ llmAvailable: true })).rejects.toThrow();
  });
});
