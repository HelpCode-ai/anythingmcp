import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import type { EditionService } from '../ee/licensing/edition.service';
import type { LicenseGuardService } from '../license/license-guard.service';
import {
  isCodeMethod,
  parseCodeToolMapping,
  validateCodeToolMapping,
} from '../mcp-server/code-tool.util';

export interface CodeToolSaveDeps {
  prisma: Pick<PrismaService, 'connector'>;
  edition?: Pick<EditionService, 'assertEnterprise'>;
  licenseGuard: Pick<LicenseGuardService, 'checkCanCreateCodeTool'>;
}

/**
 * Validate and authorize one code tool at save time (shape + authority gates),
 * for every path that stores a tool: single create and update, bulk create and
 * the JSON / backup imports.
 *
 * Shape: validateCodeToolMapping. Authority: `definer` is admin-only;
 * `allowWrites` is Enterprise-only; and every connector in `uses` must belong
 * to this connector's organization. The run time checks the organization
 * again (codeBridgeDeps in dynamic-mcp-tools.ts); this check is what tells
 * the author at save time.
 */
export async function assertValidCodeTool(
  deps: CodeToolSaveDeps,
  endpointMapping: unknown,
  connector: { organizationId: string },
  user: { role?: string },
): Promise<void> {
  const error = validateCodeToolMapping(endpointMapping);
  if (error) throw new BadRequestException(error);
  const spec = parseCodeToolMapping(endpointMapping);
  if (!spec) return;

  if (spec.runAs === 'definer' && user.role !== 'ADMIN') {
    throw new ForbiddenException('Only an admin can save a code tool that runs with definer rights.');
  }
  if (spec.allowWrites) {
    if (!deps.edition) {
      throw new ForbiddenException('Code tools that write is available with AnythingMCP Enterprise.');
    }
    await deps.edition.assertEnterprise(connector.organizationId, 'Code tools that write');
  }

  const usesIds = [...new Set(spec.uses.map((u) => u.connectorId))];
  if (usesIds.length > 0) {
    const found = await deps.prisma.connector.findMany({
      where: { id: { in: usesIds }, organizationId: connector.organizationId },
      select: { id: true },
    });
    const okIds = new Set(found.map((c) => c.id));
    const foreign = usesIds.filter((id) => !okIds.has(id));
    if (foreign.length > 0) {
      throw new BadRequestException(
        `A code tool can only use connectors from its own workspace. Unknown or foreign connector(s): ${foreign.join(', ')}.`,
      );
    }
  }
}

/**
 * Check every code tool of a batch before anything is written, then the plan's
 * code tool cap for the ones the batch adds. `label` names a tool in the error
 * (e.g. `tools[2]`), so the caller can tell which entry was refused.
 *
 * `newCodeTools` is how many of them would be created rather than update an
 * existing tool; it defaults to every code tool in the batch.
 */
export async function assertCodeToolBatch(
  deps: CodeToolSaveDeps,
  tools: Array<{ name?: string; endpointMapping?: unknown }>,
  connector: { organizationId: string },
  user: { role?: string },
  options: { label?: (index: number) => string; newCodeTools?: number } = {},
): Promise<void> {
  let codeTools = 0;
  for (const [i, t] of tools.entries()) {
    if (!isCodeMethod(t.endpointMapping)) continue;
    codeTools++;
    try {
      await assertValidCodeTool(deps, t.endpointMapping, connector, user);
    } catch (err) {
      throw prefixed(err, options.label?.(i) ?? `Tool ${t.name ?? i}`);
    }
  }
  const adding = options.newCodeTools ?? codeTools;
  if (adding > 0) {
    await deps.licenseGuard.checkCanCreateCodeTool(connector.organizationId, adding);
  }
}

/** The same HTTP error, with the refused entry named in front of its message. */
function prefixed(err: unknown, label: string): unknown {
  if (err instanceof BadRequestException) {
    return new BadRequestException(`${label}: ${err.message}`);
  }
  if (err instanceof ForbiddenException) {
    const body = err.getResponse();
    if (body && typeof body === 'object') {
      const message = (body as { message?: unknown }).message;
      return new ForbiddenException({
        ...(body as Record<string, unknown>),
        message: `${label}: ${typeof message === 'string' ? message : err.message}`,
      });
    }
    return new ForbiddenException(`${label}: ${err.message}`);
  }
  return err;
}
