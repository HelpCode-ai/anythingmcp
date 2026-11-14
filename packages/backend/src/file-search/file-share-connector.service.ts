import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { FileShareService } from './file-share.service';
import { buildFileShareBuiltinTools } from './file-search-builtins';

/**
 * The File Share connector (#1387): one per workspace, so an agent can
 * publish files it wrote. A FILE_SEARCH connector with `config.fileShare`
 * and no source; it never counts toward the File Search connector limit.
 */
@Injectable()
export class FileShareConnectorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shares: FileShareService,
    private readonly mcpServer: McpServerService,
    private readonly mcpServers: McpServersService,
  ) {}

  async find(organizationId: string) {
    const rows = await this.prisma.connector.findMany({
      where: { organizationId, type: 'FILE_SEARCH' as any },
      select: { id: true, name: true, config: true, isActive: true },
    });
    const c = rows.find((r) => (r.config as any)?.fileShare === true);
    return c ? { id: c.id, name: c.name, isActive: c.isActive } : null;
  }

  async ensure(actor: { sub: string; organizationId: string }) {
    const existing = await this.find(actor.organizationId);
    if (existing) return existing;
    if (!(await this.shares.limits(actor.organizationId))) {
      throw new ForbiddenException({ statusCode: 403, code: 'file_share_locked', message: 'File Share is not part of this plan.' });
    }
    const taken = await this.prisma.mcpTool.findFirst({
      where: { name: { in: buildFileShareBuiltinTools().map((t) => t.name) }, connector: { organizationId: actor.organizationId } },
      select: { name: true },
    });
    if (taken) throw new ConflictException(`A tool named ${taken.name} already exists in this workspace.`);
    const connector = await this.prisma.connector.create({
      data: {
        userId: actor.sub,
        organizationId: actor.organizationId,
        name: 'File Share',
        type: 'FILE_SEARCH' as any,
        baseUrl: 'file-share:',
        isActive: true,
        authType: 'NONE',
        config: { fileShare: true } as any,
        instructions:
          'File Share publishes files as temporary download links. Use share_upload for files you wrote (CSV, Markdown, JSON…). Prefer internal links; ask the user before creating a public one. Links expire on their own; share_list shows them and share_revoke ends one early.',
      },
    });
    for (const t of buildFileShareBuiltinTools()) {
      await this.prisma.mcpTool.create({
        data: { connectorId: connector.id, name: t.name, description: t.description, parameters: t.parameters as any, endpointMapping: t.endpointMapping as any },
      });
    }
    await this.mcpServer.reloadConnectorTools(connector.id);
    await this.mcpServers.attachToDefaultServer(actor.sub, actor.organizationId, connector.id);
    return { id: connector.id, name: connector.name, isActive: true };
  }
}
