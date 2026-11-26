import { BadRequestException } from '@nestjs/common';
import { AuditController, parseInvocationsQuery } from './audit.controller';

describe('GET /api/audit/invocations paging and status', () => {
  describe('parseInvocationsQuery', () => {
    it('keeps the defaults: 100 rows from the start', () => {
      expect(parseInvocationsQuery()).toEqual({ limit: 100, offset: 0, status: undefined });
    });

    it.each([
      ['50', 50],
      ['200', 200],
      ['201', 200],
      ['100000', 200],
      ['0', 1],
      ['-5', 1],
      ['abc', 100],
      ['', 100],
    ])('limit %p becomes %p', (limit, expected) => {
      expect(parseInvocationsQuery(limit).limit).toBe(expected);
    });

    it.each([
      ['0', 0],
      ['150', 150],
      ['-1', 0],
      ['x', 0],
    ])('offset %p becomes %p', (offset, expected) => {
      expect(parseInvocationsQuery(undefined, offset).offset).toBe(expected);
    });

    it.each(['SUCCESS', 'ERROR', 'TIMEOUT'])('accepts status %s', (status) => {
      expect(parseInvocationsQuery(undefined, undefined, status).status).toBe(status);
    });

    it('treats an empty status as no filter', () => {
      expect(parseInvocationsQuery(undefined, undefined, '').status).toBeUndefined();
    });

    it.each(['error', 'FAILED', 'SUCCESS,ERROR'])('refuses status %p with 400', (status) => {
      expect(() => parseInvocationsQuery(undefined, undefined, status)).toThrow(BadRequestException);
    });
  });

  describe('the route', () => {
    function build() {
      const auditService = { getRecentInvocations: jest.fn(async () => []) };
      const visibility = { scopeFor: jest.fn(async () => ({ restricted: false })) };
      const controller = new AuditController(auditService as any, visibility as any);
      return { controller, auditService };
    }
    const req = { user: { sub: 'u1', organizationId: 'org-1', role: 'ADMIN' } };

    it('passes a clamped page to the service', async () => {
      const { controller, auditService } = build();
      await controller.listInvocations(req, '5000', '-3', undefined, 'ERROR');
      expect(auditService.getRecentInvocations).toHaveBeenCalledWith(
        200,
        0,
        expect.objectContaining({ status: 'ERROR', organizationId: 'org-1' }),
      );
    });

    it('answers 400 for an unknown status without querying', async () => {
      const { controller, auditService } = build();
      await expect(controller.listInvocations(req, undefined, undefined, undefined, 'BOGUS')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(auditService.getRecentInvocations).not.toHaveBeenCalled();
    });
  });
});
