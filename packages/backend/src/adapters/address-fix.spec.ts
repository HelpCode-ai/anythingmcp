import { addressFix, describeAddressFix, withMissingScheme } from './address-fix';
import { describeAdapterEnvVars } from './env-var-meta';
import { getAdapter } from './catalog';

/** The pattern of one catalog variable, as the setup form gets it. */
function patternOf(slug: string, name: string): string {
  const adapter = getAdapter(slug);
  if (!adapter) throw new Error(`no adapter ${slug}`);
  const d = describeAdapterEnvVars(adapter).find((x) => x.name === name);
  if (!d?.pattern) throw new Error(`${slug}.${name} has no pattern`);
  return d.pattern;
}

describe('withMissingScheme', () => {
  it('adds https:// to a host the address patterns want with a scheme', () => {
    for (const [slug, name, typed] of [
      ['odoo', 'ODOO_URL', 'amcp-e2e-test.odoo.com'],
      ['odoo-jsonrpc', 'ODOO_URL', 'erp.acme.de'],
      ['woocommerce', 'WOOCOMMERCE_URL', 'shop.example.com'],
      ['prestashop', 'PRESTASHOP_URL', 'shop.example.com'],
      ['xentral', 'XENTRAL_URL', 'acme.xentral.biz'],
      ['gitlab', 'GITLAB_URL', 'gitlab.example.com'],
      ['zoho-mail', 'ZOHO_MAIL_ACCOUNTS_URL', 'accounts.zoho.eu'],
    ]) {
      expect(withMissingScheme(patternOf(slug, name), typed)).toBe(`https://${typed}`);
    }
  });

  it('keeps a value that already has a scheme, or that the pattern wants without one', () => {
    expect(withMissingScheme(patternOf('odoo', 'ODOO_URL'), 'http://erp.internal.lan:8069')).toBe('http://erp.internal.lan:8069');
    // Exercise.com wants the bare host: it already matches.
    expect(withMissingScheme(patternOf('exercise-com', 'EXERCISE_HOST'), 'train.yourgym.com')).toBe('train.yourgym.com');
    // Amplitude takes it with or without.
    expect(withMissingScheme(patternOf('amplitude', 'AMPLITUDE_API_HOST'), 'amplitude.com')).toBe('amplitude.com');
  });

  it('still leaves a value that is wrong in another way for the pattern to refuse', () => {
    // A path after the host is not fixed by a scheme.
    expect(withMissingScheme(patternOf('odoo', 'ODOO_URL'), 'acme.odoo.com/web')).toBe('acme.odoo.com/web');
    // www. on odoo.com is refused by the Odoo pattern, with or without https://.
    expect(withMissingScheme(patternOf('odoo', 'ODOO_URL'), 'www.acme.odoo.com')).toBe('www.acme.odoo.com');
    // Not an address: a single-label host (http or https cannot be told), spaces, a word.
    expect(withMissingScheme(patternOf('odoo', 'ODOO_URL'), 'erp:8069')).toBe('erp:8069');
    expect(withMissingScheme(patternOf('odoo', 'ODOO_URL'), 'my odoo')).toBe('my odoo');
    expect(withMissingScheme(undefined, 'acme.odoo.com')).toBe('acme.odoo.com');
  });

  it('never throws on a broken pattern', () => {
    expect(withMissingScheme('([', 'acme.odoo.com')).toBe('acme.odoo.com');
  });
});

describe('addressFix', () => {
  const odoo = patternOf('odoo', 'ODOO_URL');

  it('names the missing https://', () => {
    const fix = addressFix(patternOf('xentral', 'XENTRAL_URL'), 'acme.xentral.biz')!;
    expect(fix).toEqual({ value: 'https://acme.xentral.biz', changes: ['scheme'] });
    expect(describeAddressFix(fix)).toBe('Add https:// in front: https://acme.xentral.biz.');
  });

  it('names what to cut after the host', () => {
    const fix = addressFix(odoo, 'https://acme.odoo.com/odoo/discuss?debug=1')!;
    expect(fix.value).toBe('https://acme.odoo.com');
    expect(describeAddressFix(fix)).toBe('Remove /odoo/discuss?debug=1 after the host: https://acme.odoo.com.');
  });

  it('drops a trailing slash before cutting a path the pattern allows', () => {
    const fix = addressFix(patternOf('metabase', 'METABASE_URL'), 'https://bi.example.com/metabase/')!;
    expect(describeAddressFix(fix)).toBe('Remove the / at the end: https://bi.example.com/metabase.');
  });

  it('combines changes into one sentence', () => {
    const fix = addressFix(patternOf('woocommerce', 'WOOCOMMERCE_URL'), 'http://shop.example.com/')!;
    expect(describeAddressFix(fix)).toBe('Use https:// instead of http:// and remove the / at the end: https://shop.example.com.');
    expect(describeAddressFix(addressFix(odoo, 'www.acme.odoo.com/web')!)).toBe(
      'Add https:// in front, remove the www. and remove /web after the host: https://acme.odoo.com.',
    );
  });

  it('says nothing when the value matches or no small change helps', () => {
    expect(addressFix(odoo, 'https://acme.odoo.com')).toBeUndefined();
    // Smartsheet needs /2.0, which cannot be guessed.
    expect(addressFix(patternOf('smartsheet', 'SMARTSHEET_API_URL'), 'https://api.smartsheet.com')).toBeUndefined();
    expect(addressFix(odoo, 'not an address')).toBeUndefined();
    expect(addressFix(odoo, '')).toBeUndefined();
  });
});
