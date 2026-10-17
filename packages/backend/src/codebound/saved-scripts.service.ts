import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../common/prisma.service';
import { SecurityEventService } from '../audit/security-event.service';
import { LicenseGuardService } from '../license/license-guard.service';
import { PaginationQueryDto } from '../common/pagination.dto';
import { CodeboundService, ScriptCaller } from './codebound.service';
import {
  RunSavedScriptDto,
  SaveScriptDto,
  UpdateScriptDto,
} from './codebound.dto';

const SUMMARY = {
  id: true,
  name: true,
  description: true,
  mcpServerId: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CodeboundScriptSelect;
const FULL = {
  ...SUMMARY,
  code: true,
  input: true,
  allowedTools: true,
} satisfies Prisma.CodeboundScriptSelect;

@Injectable()
export class SavedScriptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: CodeboundService,
    private readonly license: LicenseGuardService,
    private readonly audit: SecurityEventService,
  ) {}

  private assertCanWrite(caller: ScriptCaller) {
    if (!['ADMIN', 'EDITOR'].includes(caller.role ?? '')) {
      throw new ForbiddenException(
        'An editor or administrator can save and delete scripts.',
      );
    }
  }

  private async assertServer(caller: ScriptCaller, id: string) {
    const server = await this.prisma.mcpServerConfig.findFirst({
      where: { id, organizationId: caller.organizationId, isActive: true },
      select: { id: true },
    });
    if (!server) throw new NotFoundException('Active MCP server not found.');
  }

  private scriptData(dto: SaveScriptDto) {
    if (!dto.name.trim())
      throw new BadRequestException('Script name is required.');
    if (Buffer.byteLength(JSON.stringify(dto.input)) > 65536) {
      throw new BadRequestException('Default parameters exceed 64 KiB.');
    }
    return {
      name: dto.name.trim(),
      description: dto.description,
      mcpServerId: dto.mcpServerId,
      code: dto.code,
      input: dto.input as Prisma.InputJsonObject,
      allowedTools: dto.allowedTools,
    };
  }

  async list(caller: ScriptCaller, pagination: PaginationQueryDto) {
    const where = { organizationId: caller.organizationId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.codeboundScript.findMany({
        where,
        select: SUMMARY,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: pagination.offset ?? 0,
        take: pagination.limit ?? 20,
      }),
      this.prisma.codeboundScript.count({ where }),
    ]);
    return { items, total };
  }

  async get(caller: ScriptCaller, id: string) {
    const script = await this.prisma.codeboundScript.findFirst({
      where: { id, organizationId: caller.organizationId },
      select: FULL,
    });
    if (!script) throw new NotFoundException('Script not found.');
    return script;
  }

  private async record(
    event: string,
    caller: ScriptCaller,
    script: { id: string; mcpServerId: string; revision: number },
  ) {
    await this.audit.log({
      event,
      actorType: 'USER',
      actorUserId: caller.sub,
      organizationId: caller.organizationId,
      metadata: {
        scriptId: script.id,
        serverId: script.mcpServerId,
        revision: script.revision,
      },
    });
  }

  async create(caller: ScriptCaller, dto: SaveScriptDto) {
    this.assertCanWrite(caller);
    await this.license.checkLicenseActive(caller.organizationId);
    const data = this.scriptData(dto);
    await this.assertServer(caller, dto.mcpServerId);
    try {
      const script = await this.prisma.codeboundScript.create({
        data: { ...data, organizationId: caller.organizationId },
        select: FULL,
      });
      await this.record('CODEBOUND_SCRIPT_CREATED', caller, script);
      return script;
    } catch (error) {
      // A server may have been removed between validation and the FK write.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new NotFoundException('MCP server is no longer available.');
      }
      throw error;
    }
  }

  async update(caller: ScriptCaller, id: string, dto: UpdateScriptDto) {
    this.assertCanWrite(caller);
    await this.license.checkLicenseActive(caller.organizationId);
    const data = this.scriptData(dto);
    // Resolve the script in this workspace before considering the replacement server.
    await this.get(caller, id);
    await this.assertServer(caller, dto.mcpServerId);
    try {
      const script = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.codeboundScript.updateMany({
          where: {
            id,
            organizationId: caller.organizationId,
            revision: dto.revision,
          },
          data: { ...data, revision: { increment: 1 } },
        });
        if (updated.count === 0) {
          const current = await tx.codeboundScript.findFirst({
            where: { id, organizationId: caller.organizationId },
            select: { id: true },
          });
          if (!current) throw new NotFoundException('Script not found.');
          throw new ConflictException(
            'Script changed. Reopen it before saving.',
          );
        }
        // Keep the read in the transaction so the response matches this revision.
        return tx.codeboundScript.findFirstOrThrow({
          where: { id, organizationId: caller.organizationId },
          select: FULL,
        });
      });
      await this.record('CODEBOUND_SCRIPT_UPDATED', caller, script);
      return script;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new NotFoundException('MCP server is no longer available.');
      }
      throw error;
    }
  }

  async delete(caller: ScriptCaller, id: string) {
    this.assertCanWrite(caller);
    const script = await this.get(caller, id);
    const deleted = await this.prisma.codeboundScript.deleteMany({
      where: { id, organizationId: caller.organizationId },
    });
    if (deleted.count === 0) throw new NotFoundException('Script not found.');
    await this.record('CODEBOUND_SCRIPT_DELETED', caller, script);
    return { deleted: true };
  }

  async run(caller: ScriptCaller, id: string, dto: RunSavedScriptDto) {
    const script = await this.get(caller, id);
    if (dto.revision !== script.revision)
      throw new ConflictException('Script changed. Reopen it before running.');
    // Source, server and capabilities come exclusively from the stored record.
    // The runner rechecks the caller's live connector permissions for each call.
    return this.runner.run(
      caller,
      script.mcpServerId,
      {
        code: script.code,
        input: dto.input,
        allowedTools: script.allowedTools,
      },
      { id: script.id, revision: script.revision },
    );
  }
}
