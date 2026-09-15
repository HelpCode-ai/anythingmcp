import {
  operatorProvidedEnvVars,
  withOperatorProvided,
  withoutOperatorProvided,
} from './cloud-managed-env';

describe('operator-provided adapter env vars', () => {
  it('is empty when the operator set nothing', () => {
    expect(operatorProvidedEnvVars({})).toEqual({});
    expect(withoutOperatorProvided(['MOTIS_URL'], {})).toEqual(['MOTIS_URL']);
    expect(withOperatorProvided(undefined, {})).toBeUndefined();
  });

  it('maps MOTIS_INTERNAL_URL onto the adapter var, without a trailing slash', () => {
    const env = { MOTIS_INTERNAL_URL: 'http://motis:8080/' };
    expect(operatorProvidedEnvVars(env)).toEqual({ MOTIS_URL: 'http://motis:8080' });
  });

  it('ignores a blank value', () => {
    expect(operatorProvidedEnvVars({ MOTIS_INTERNAL_URL: '  ' })).toEqual({});
  });

  it('hides the provided var from the install form and leaves the rest', () => {
    const env = { MOTIS_INTERNAL_URL: 'http://motis:8080' };
    expect(withoutOperatorProvided(['MOTIS_URL', 'OTHER'], env)).toEqual(['OTHER']);
    expect(withoutOperatorProvided(undefined, env)).toBeUndefined();
  });

  it('lets the operator value win over one posted by the user', () => {
    // A cloud user must not be able to aim the connector at an arbitrary host
    // on the internal network by sending their own MOTIS_URL.
    const env = { MOTIS_INTERNAL_URL: 'http://motis:8080' };
    expect(
      withOperatorProvided({ MOTIS_URL: 'http://169.254.169.254', X: '1' }, env),
    ).toEqual({ MOTIS_URL: 'http://motis:8080', X: '1' });
  });
});
