import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { ProductEvents, ProductEventService } from './product-event.service';

/** Pages of the dashboard that report a catalog search. */
const CLIENT_SEARCH_SURFACES = new Set(['store', 'welcome']);

/**
 * POST /api/product-events — the UI reports a funnel step.
 *
 * Always 204, even for an unknown event name: the page fires these and moves
 * on, and a rejected beacon would only show up as console noise. Unknown names
 * are dropped server-side; the allow-list lives in ProductEventService.
 */
@ApiTags('Product events')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/product-events')
export class ProductEventController {
  constructor(private readonly events: ProductEventService) {}

  @Post()
  @HttpCode(204)
  @ApiOperation({ summary: 'Record a product-usage event for the signed-in user' })
  async record(
    @Req() req: any,
    @Body() body: { event?: unknown; metadata?: Record<string, unknown> },
  ): Promise<void> {
    if (!this.events.isKnown(body?.event)) return;
    // Searches from a chat are recorded by the server; a page reports only its own.
    if (
      (body.event === ProductEvents.CATALOG_SEARCH || body.event === ProductEvents.CATALOG_SEARCH_PICKED) &&
      !CLIENT_SEARCH_SURFACES.has(body.metadata?.via as string)
    ) {
      return;
    }
    await this.events.log({
      event: body.event,
      userId: req.user?.sub ?? null,
      organizationId: req.user?.organizationId ?? null,
      metadata: body.metadata ?? null,
    });
  }
}
