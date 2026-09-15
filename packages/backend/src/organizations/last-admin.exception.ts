import { ConflictException } from '@nestjs/common';

/**
 * Thrown when an action would leave an organization with no ACTIVE admin.
 *
 * Lives in its own file so that `UsersModule` and `IdentityProvidersModule`
 * can both import it without pulling in `OrganizationsService` and creating a
 * module cycle. The `code` lets non-JSON callers (SCIM) map it to their own
 * error shape.
 */
export class LastAdminConflictException extends ConflictException {
  constructor(organizationId: string) {
    super({
      code: 'LAST_ADMIN',
      error:
        'Cannot remove the only administrator of this organization. Promote another member first.',
      organizationId,
    });
  }
}
