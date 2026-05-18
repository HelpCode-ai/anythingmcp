import { GraphqlSchemaService } from './graphql-schema.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const SAMPLE_SDL = `
"""
The root of all queries.
"""
type Query {
  currentUser: CurrentUser
  searchPlayers(query: String): SearchPlayers!
  football: FootballRoot!
}

type Mutation {
  signIn(input: SignInInput!): SignInPayload!
}

"""
Authenticated user.
"""
type CurrentUser {
  slug: String!
  nickname: String!
  cards(first: Int): AnyCardConnection!
}

type SearchPlayers {
  hitIds: [String!]!
  nbHits: Int!
}

enum Rarity {
  COMMON
  LIMITED
  RARE
}

union Account = EthereumAccount | FiatWalletAccount

scalar WeiAmount

type FootballRoot {
  card(slug: String!): Card!
}
`;

describe('GraphqlSchemaService', () => {
  let svc: GraphqlSchemaService;
  const url = 'https://api.example.com/graphql/schema';

  beforeEach(() => {
    svc = new GraphqlSchemaService();
    jest.clearAllMocks();
    (mockedAxios.get as any) = jest.fn().mockResolvedValue({ data: SAMPLE_SDL });
  });

  it('returns the entire SDL when full=true', async () => {
    const out = await svc.getSlice(url, { full: true });
    expect(out).toBe(SAMPLE_SDL);
  });

  it('returns the block for a single type', async () => {
    const out = await svc.getSlice(url, { type: 'CurrentUser' });
    expect(out).toContain('type CurrentUser {');
    expect(out).toContain('cards(first: Int): AnyCardConnection!');
    // includes preceding docblock
    expect(out).toContain('Authenticated user.');
    // does not include unrelated types
    expect(out).not.toContain('type FootballRoot');
  });

  it('handles enum, union, and scalar declarations', async () => {
    expect(await svc.getSlice(url, { type: 'Rarity' })).toContain('enum Rarity');
    expect(await svc.getSlice(url, { type: 'Account' })).toContain(
      'union Account = EthereumAccount | FiatWalletAccount',
    );
    expect(await svc.getSlice(url, { type: 'WeiAmount' })).toContain('scalar WeiAmount');
  });

  it('returns a friendly message when the type is missing', async () => {
    const out = await svc.getSlice(url, { type: 'DoesNotExist' });
    expect(out).toMatch(/not found in schema/);
  });

  it('search returns matching types with their blocks', async () => {
    const out = await svc.getSlice(url, { search: 'player' });
    expect(out).toContain('searchPlayers'); // matched via field
    expect(out).toContain('SearchPlayers'); // matched via type name
  });

  it('default summary includes Query / Mutation blocks plus type index', async () => {
    const out = await svc.getSlice(url);
    expect(out).toContain('# Schema summary');
    expect(out).toContain('type Query {');
    expect(out).toContain('type Mutation {');
    // Type index lists all top-level types
    expect(out).toMatch(/types available/);
    expect(out).toContain('CurrentUser');
    expect(out).toContain('FootballRoot');
  });

  it('caches the fetched SDL across calls', async () => {
    await svc.getSlice(url, { type: 'Query' });
    await svc.getSlice(url, { type: 'CurrentUser' });
    await svc.getSlice(url, { search: 'card' });
    expect((mockedAxios.get as jest.Mock).mock.calls.length).toBe(1);
  });
});
