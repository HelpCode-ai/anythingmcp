import type { PrismaService } from '../common/prisma.service';
import { ProductEvents, type ProductEventService } from './product-event.service';
import type { DirectoryPluginEndpoint } from '../auth/resource-indicator.middleware';

/**
 * How long after creating an account its first authorization of a directory
 * plugin still counts as "signed up from the directory". A ChatGPT user who
 * clicks Connect lands on our login page, signs up, may go through the trial
 * checkout and the first connector, then approves: minutes, not hours.
 */
export const DIRECTORY_SIGNUP_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Marks a sign-up that came from AnythingMCP's plugin in OpenAI's plugin
 * directory.
 *
 * The sign-up itself cannot tell: the user reaches the login page through an
 * OAuth redirect, so the visit carries no referrer or campaign tag and
 * signup_attributed records the channel as 'direct'. The authorization that
 * follows names the plugin endpoint (RFC 8707 `resource`). When a recent
 * account authorizes a directory plugin, its signup_attributed gets
 * `directory: 'chatgpt'` and `directory_plugin`, and a `directory_signup` event
 * is written once.
 *
 * The channel fields are left as they are: other code reads first_channel
 * ('direct' = no stated intent) and must keep seeing the same value.
 *
 * Never throws: the report must not get in the way of the authorization.
 */
export async function markDirectorySignup(
  prisma: Pick<PrismaService, 'user' | 'productEvent'>,
  events: Pick<ProductEventService, 'log'> | undefined,
  userId: string,
  plugin: DirectoryPluginEndpoint,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } });
    if (!user || now - user.createdAt.getTime() > DIRECTORY_SIGNUP_WINDOW_MS) return false;

    const already = await prisma.productEvent.count({
      where: { userId, event: ProductEvents.DIRECTORY_SIGNUP },
    });
    if (already > 0) return false;

    const signup = await prisma.productEvent.findFirst({
      where: { userId, event: ProductEvents.SIGNUP_ATTRIBUTED },
      orderBy: { createdAt: 'asc' },
      select: { id: true, metadata: true },
    });
    if (signup) {
      const metadata =
        signup.metadata && typeof signup.metadata === 'object' && !Array.isArray(signup.metadata)
          ? (signup.metadata as Record<string, unknown>)
          : {};
      await prisma.productEvent.update({
        where: { id: signup.id },
        data: { metadata: { ...metadata, directory: 'chatgpt', directory_plugin: plugin } },
      });
    }

    await events?.log({
      event: ProductEvents.DIRECTORY_SIGNUP,
      userId,
      metadata: { directory: 'chatgpt', plugin },
    });
    return true;
  } catch {
    return false;
  }
}
