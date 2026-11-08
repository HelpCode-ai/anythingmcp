import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { processGauges } from '../common/process-vitals';
import { trackMcpRequestClose } from './mcp-endpoint.controller';

function fakeRes(state: { closed?: boolean; destroyed?: boolean; writableFinished?: boolean } = {}) {
  const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(res, { closed: false, destroyed: false, writableFinished: false }, state);
  return res as unknown as Response;
}

describe('trackMcpRequestClose', () => {
  beforeEach(() => processGauges.reset());

  it('decrements the in-flight gauge when the socket closes after a full answer', () => {
    processGauges.inc('mcpRequestsInFlight');
    const res = fakeRes();
    trackMcpRequestClose(res);
    expect(processGauges.get('mcpRequestsInFlight')).toBe(1);
    (res as unknown as Record<string, unknown>).writableFinished = true;
    (res as unknown as EventEmitter).emit('close');
    expect(processGauges.get('mcpRequestsInFlight')).toBe(0);
    expect(processGauges.get('mcpAbortedTotal')).toBe(0);
  });

  it('counts an abort when the socket closes before the answer is written', () => {
    processGauges.inc('mcpRequestsInFlight');
    const res = fakeRes();
    trackMcpRequestClose(res);
    (res as unknown as EventEmitter).emit('close');
    expect(processGauges.get('mcpRequestsInFlight')).toBe(0);
    expect(processGauges.get('mcpAbortedTotal')).toBe(1);
  });

  it.each([
    ['closed', { closed: true }],
    ['destroyed', { destroyed: true }],
  ])('settles a response that is already %s, whose close event will not fire again', (_label, state) => {
    // Two requests in flight: this one and another, still open.
    processGauges.inc('mcpRequestsInFlight', 2);
    const res = fakeRes(state);
    trackMcpRequestClose(res);
    expect(processGauges.get('mcpRequestsInFlight')).toBe(1);
    expect(processGauges.get('mcpAbortedTotal')).toBe(1);
    // A late close (should one come) must not decrement twice.
    (res as unknown as EventEmitter).emit('close');
    expect(processGauges.get('mcpRequestsInFlight')).toBe(1);
  });

  it('decrements at once for a mock without once()', () => {
    processGauges.inc('mcpRequestsInFlight');
    trackMcpRequestClose({} as Response);
    expect(processGauges.get('mcpRequestsInFlight')).toBe(0);
  });
});
