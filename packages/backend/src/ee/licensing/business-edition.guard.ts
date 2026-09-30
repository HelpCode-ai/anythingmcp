import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EditionService } from './edition.service';

const CAPABILITY_KEY = 'business_capability';

/** Names the capability in the 403 message, e.g. `@BusinessCapability('Single sign-on')`. */
export const BusinessCapability = (name: string) => SetMetadata(CAPABILITY_KEY, name);

/** Lets a route through only when the instance has Business capabilities. */
@Injectable()
export class BusinessEditionGuard implements CanActivate {
  constructor(
    private readonly edition: EditionService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const capability =
      this.reflector.getAllAndOverride<string>(CAPABILITY_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'This feature';
    await this.edition.assertBusiness(capability);
    return true;
  }
}
