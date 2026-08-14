import {
  applyResponseTransform,
  validateTransform,
} from '../../connectors/response-transform.util';
import * as adapter from './georgian-railway.json';

/**
 * Static conformance for the Georgian Railway adapter.
 *
 * gr.com.ge exposes no documented API — this connector is built on the JSON
 * endpoints its own site calls. Two things are therefore worth pinning: the
 * request shape (so a careless edit doesn't silently point at the wrong host or
 * verb) and the response mappings, which do the real work here. The upstream
 * payload repeats each station in five near-identical objects, so the mapping
 * is what makes the tool usable rather than a nicety.
 *
 * No network calls: the fixtures below are trimmed captures of real responses.
 */

const a = adapter as unknown as {
  slug: string;
  connector: { baseUrl: string; authType: string; headers: Record<string, string> };
  tools: Array<{
    name: string;
    endpointMapping: { method: string; path: string };
    responseMapping?: Record<string, unknown>;
  }>;
};

const tool = (name: string) => a.tools.find((t) => t.name === name)!;

describe('georgian-railway adapter — connector', () => {
  it('targets gr.com.ge without credentials', () => {
    expect(a.connector.baseUrl).toBe('https://gr.com.ge');
    expect(a.connector.authType).toBe('NONE');
  });

  it('sends the headers the API requires', () => {
    // The API answers with the site's HTML shell instead of JSON unless it is
    // asked for JSON, and localises station names off interface-language.
    expect(a.connector.headers.Accept).toBe('application/json');
    expect(a.connector.headers['interface-language']).toBe('en');
    expect(a.connector.headers['x-device']).toBe('web');
  });

  it('exposes exactly the three read tools', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual([
      'gr_get_notifications',
      'gr_search_stations',
      'gr_search_trains',
    ]);
  });

  it('routes each tool at the endpoint the site uses', () => {
    expect(tool('gr_search_stations').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/api/stations',
    });
    // Search is a POST that answers 201 — it creates a search resource
    // server-side. Switching it to GET returns the site's HTML, not results.
    expect(tool('gr_search_trains').endpointMapping).toMatchObject({
      method: 'POST',
      path: '/api/ticket-search',
    });
    expect(tool('gr_get_notifications').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/api/info-content',
    });
  });

  it('has a valid transform on every tool that declares one', () => {
    for (const t of a.tools) {
      const transform = (t.responseMapping as { transform?: unknown } | undefined)?.transform;
      if (transform === undefined) continue;
      expect(validateTransform(transform)).toBeNull();
    }
  });
});

describe('georgian-railway adapter — response mappings', () => {
  it('flattens a journey search into trains with fares and seat counts', () => {
    // Real shape: [[outbound…],[return…]], each train repeating its stations.
    const raw = [
      [
        {
          id: 22461,
          guid: '86481baf',
          rideNumber: 803,
          saleFlag: true,
          rideStartDate: '2026-08-25T04:00:00Z',
          rideStartStation: {
            station: { id: 309, code: '57151', name: 'BATUMI(pass)' },
            departureTime: '08:00:00',
            arrivalTime: '08:08:00',
          },
          rideEndStation: {
            station: { id: 98, code: '56014', name: 'TBILISI(pass)' },
            departureTime: '12:00:00',
            arrivalTime: '12:12:00',
          },
          availableSeatsClasses: [
            {
              seatClass: { id: 2, name: 'II Class' },
              availableNumberOfSeats: 17,
              priceOfSeats: { amount: 35, currencyCode: 'GEL' },
            },
          ],
        },
      ],
      [
        {
          rideNumber: 804,
          saleFlag: true,
          rideStartDate: '2026-08-27T13:10:00Z',
          rideStartStation: {
            station: { code: '56014', name: 'TBILISI(pass)' },
            departureTime: '17:10:00',
          },
          rideEndStation: {
            station: { code: '57151', name: 'BATUMI(pass)' },
            arrivalTime: '21:21:00',
          },
          availableSeatsClasses: [],
        },
      ],
    ];

    const out = applyResponseTransform(raw, tool('gr_search_trains').responseMapping as any);
    expect(out.applied).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual([
      {
        train: 803,
        from: 'BATUMI(pass)',
        to: 'TBILISI(pass)',
        departure: '08:00:00',
        arrival: '12:12:00',
        date: '2026-08-25T04:00:00Z',
        onSale: true,
        classes: [{ class: 'II Class', seatsLeft: 17, price: 35, currency: 'GEL' }],
      },
      {
        train: 804,
        from: 'TBILISI(pass)',
        to: 'BATUMI(pass)',
        departure: '17:10:00',
        arrival: '21:21:00',
        date: '2026-08-27T13:10:00Z',
        onSale: true,
        // Sold out for the requested party — the train still runs. The
        // instructions tell the agent to report this as sold out, not as
        // "no such train".
        classes: [],
      },
    ]);
  });

  it('cuts a real journey payload by roughly an order of magnitude', () => {
    const train = {
      rideNumber: 803,
      saleFlag: true,
      rideStartDate: '2026-08-25T04:00:00Z',
      routeType: { id: 2, code: 'local', name: 'მაგისტრალური', cultureName: [] },
      // The upstream payload carries the same station five times over.
      rideStartStation: { station: { code: '57151', name: 'BATUMI(pass)' }, departureTime: '08:00:00' },
      startStation: { station: { code: '57151', name: 'BATUMI(pass)' }, departureTime: '08:00:00' },
      actualStation: { station: { code: '57151', name: 'BATUMI(pass)' }, departureTime: '08:00:00' },
      previousStation: null,
      rideEndStation: { station: { code: '56014', name: 'TBILISI(pass)' }, arrivalTime: '12:12:00' },
      endStation: { station: { code: '56014', name: 'TBILISI(pass)' }, arrivalTime: '12:12:00' },
      availableSeatsClasses: [
        {
          carriageModel: null,
          carriageRang: null,
          carriageType: null,
          seatGroupProperty: null,
          seatClass: { id: 2, guid: 'Guid', index: 2, code: 'II Class', name: 'II Class', color: '#AED6F1' },
          availableNumberOfSeats: 17,
          priceOfSeats: { amount: 35, currencyCode: 'GEL' },
          priceOfSeatsCash: null,
        },
      ],
      availableSeatsGroups: [],
    };
    const raw = [[train, train, train, train]];

    const out = applyResponseTransform(raw, tool('gr_search_trains').responseMapping as any);
    const before = Buffer.byteLength(JSON.stringify(raw));
    const after = Buffer.byteLength(JSON.stringify(out.value));
    expect(out.applied).toBe(true);
    expect(after).toBeLessThan(before / 4);
  });

  it('reduces the station list to codes and names', () => {
    const raw = {
      status: 'success',
      data: {
        data: [
          {
            id: 309,
            station_id: '112',
            name: 'ბათუმი',
            name_en: 'Batumi',
            name_ka: 'ბათუმი',
            name_ru: 'БАТУМИ',
            station_code: '57151',
            priority: 0,
            hide: false,
            created_at: '2025-01-01T00:00:00Z',
            updated_at: '2025-01-01T00:00:00Z',
            deleted_at: null,
            station_country_id: 1,
            station_country: null,
          },
        ],
        meta: { itemsPerPage: 20, totalItems: 2, currentPage: 1, totalPages: 1 },
        links: {},
      },
    };

    const out = applyResponseTransform(raw, tool('gr_search_stations').responseMapping as any);
    expect(out.applied).toBe(true);
    expect(out.value).toEqual({
      total: 2,
      page: 1,
      totalPages: 1,
      stations: [{ code: '57151', name: 'Batumi', nameKa: 'ბათუმი', nameRu: 'БАТУМИ' }],
    });
  });

  it('caches the station list, which changes rarely', () => {
    expect((tool('gr_search_stations').responseMapping as any).cacheTtl).toBe(86400);
  });
});
