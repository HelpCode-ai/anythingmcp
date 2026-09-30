/**
 * What a scene script gets: the page (to find things) and a few verbs that
 * act through the real cursor and keyboard at human speed.
 */
import type { Locator, Page } from 'playwright-core';
import { Human } from './human';
import { screenBox } from './browser';

export class Scene {
  /**
   * `human` null = dry run: synthetic Playwright input in a headless browser,
   * to check a script's selectors and flow without taking over the Mac.
   */
  constructor(
    readonly page: Page,
    readonly human: Human | null,
  ) {}

  /** Move to the element and click it. */
  async click(target: Locator, dwell?: number): Promise<void> {
    await target.waitFor({ state: 'visible', timeout: 15_000 });
    if (!this.human) return target.click();
    await this.human.clickBox(await screenBox(this.page, target), { dwell });
  }

  /** Rest the cursor on an element without clicking, as people do while reading. */
  async hover(target: Locator, ms = 700): Promise<void> {
    await target.waitFor({ state: 'visible', timeout: 15_000 });
    if (!this.human) return target.hover();
    const b = await screenBox(this.page, target);
    await this.human.moveTo(b.x + b.width * 0.5, b.y + b.height * 0.5, Math.min(b.width, b.height));
    await this.human.pause(ms * 0.8, ms * 1.2);
  }

  /** Click into a field and type into it. */
  async type(target: Locator, text: string, speed = 1): Promise<void> {
    await this.click(target);
    if (!this.human) return target.pressSequentially(text);
    await this.human.pause(150, 300);
    await this.human.type(text, speed);
  }

  /** Click into a field and paste (long URLs, keys). */
  async paste(target: Locator, text: string): Promise<void> {
    await this.click(target);
    if (!this.human) return target.fill(text);
    await this.human.paste(text);
  }

  /** Pick an option of a Radix select. */
  async select(trigger: Locator, option: string): Promise<void> {
    await this.click(trigger);
    await this.page.waitForTimeout(300);
    await this.click(this.page.getByRole('option', { name: option, exact: true }));
  }

  /** Smoothly scroll the page (or a container) by `dy` CSS pixels. */
  async scroll(dy: number, container?: Locator): Promise<void> {
    if (container) {
      await container.evaluate((el, d) => el.scrollBy({ top: d, behavior: 'smooth' }), dy);
    } else {
      // The app shell scrolls an inner container, not the window.
      await this.page.evaluate((d) => {
        const all = [document.scrollingElement, ...document.querySelectorAll('main, div')] as Element[];
        const box = all
          .filter((el) => el && el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY))
          .sort((a, b) => b.clientHeight - a.clientHeight)[0];
        (box ?? document.scrollingElement)?.scrollBy({ top: d, behavior: 'smooth' });
      }, dy);
    }
    await this.page.waitForTimeout(800);
  }

  /** Smoothly bring an element to the upper part of the viewport. */
  async scrollTo(target: Locator, offset = 120): Promise<void> {
    await target.evaluate((el, off) => {
      (el as HTMLElement).style.scrollMarginTop = `${off}px`;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, offset);
    await this.page.waitForTimeout(900);
  }

  async wait(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async waitFor(target: Locator, timeout = 30_000): Promise<void> {
    await target.waitFor({ state: 'visible', timeout });
  }
}

export type SceneScript = {
  /** Mock-backend stage to reset to before the take (web-app scenes). */
  stage?: 'etsy' | 'sap' | 'openapi' | 'all';
  /** Where the recording window opens. */
  start: string;
  /** Off-camera setup, before the take waits for the go signal; ends on the take's first frame. */
  prepare?: (page: Page) => Promise<void>;
  run: (s: Scene) => Promise<void>;
};
