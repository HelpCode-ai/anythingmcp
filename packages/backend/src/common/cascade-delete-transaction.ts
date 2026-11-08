/**
 * Transaction options for deleting an account or a workspace.
 *
 * Deleting an organization cascades into many tables (connectors, tools,
 * tool invocations, product events, knowledge-graph nodes, ...). On a large
 * shared database this can take longer than Prisma's default 5 s transaction
 * timeout, which rolls the delete back and returns a 500 to the user.
 */
export const CASCADE_DELETE_TRANSACTION = {
  maxWait: 10_000,
  timeout: 60_000,
} as const;
