import { Injectable } from '@nestjs/common';

/** A request of an AI client that reached the shared MCP endpoint. */
export interface McpClientSeen {
  /** The workspace the connection reaches. */
  organizationId: string;
  /** The user the connection belongs to, when there is one. */
  userId: string | null;
}

/**
 * Lets a module that the MCP endpoint cannot import (it imports this one)
 * hear that a workspace's AI client is really connected: the endpoint tells
 * the registry on every tools/list of the shared endpoint, the first thing a
 * client does with a connection.
 *
 * `notify` runs on the request's path, so a listener must return at once and
 * do its work in the background; one that throws is skipped. Nothing here
 * waits, and nothing here can fail the request.
 */
@Injectable()
export class McpClientSeenRegistry {
  private readonly listeners: Array<(seen: McpClientSeen) => void> = [];

  register(listener: (seen: McpClientSeen) => void): void {
    this.listeners.push(listener);
  }

  notify(seen: McpClientSeen): void {
    for (const listener of this.listeners) {
      try {
        listener(seen);
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}
