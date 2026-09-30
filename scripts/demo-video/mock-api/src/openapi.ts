/**
 * OpenAPI 3.1 description of the Lumen Logistics API. AnythingMCP imports it
 * in the video's third case; each operationId becomes one MCP tool, so the
 * summaries and descriptions below are what Claude reads.
 */
export function logisticsOpenApi(serverUrl: string) {
  const idParam = (name: string, description: string) => ({ name, in: 'path', required: true, description, schema: { type: 'string' } });
  const json = (schemaRef: string, description = 'OK') => ({
    description,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaRef}` } } },
  });

  return {
    openapi: '3.1.0',
    info: {
      title: 'Lumen Logistics API',
      version: '1.4.0',
      description:
        'Shipping and fulfilment API of Lumen & Clay. Every Etsy order that leaves a warehouse is a shipment here; ' +
        'its order_ref is `ETSY-<receipt_id>` and it carries the same carrier and tracking number as the Etsy receipt.',
    },
    servers: [{ url: serverUrl }],
    security: [{ apiKey: [] }],
    tags: [{ name: 'Shipments' }, { name: 'Tracking' }, { name: 'Carriers' }, { name: 'Warehouses' }, { name: 'Returns' }],
    paths: {
      '/shipments': {
        get: {
          operationId: 'logistics_list_shipments',
          tags: ['Shipments'],
          summary: 'List shipments',
          description:
            'Shipments, newest first. Filter by status to find problems: `delayed` (late or damaged in transit) and `lost` (carrier trace opened).',
          parameters: [
            { name: 'status', in: 'query', description: 'in_transit, delivered, delayed or lost. Comma-separated for several.', schema: { type: 'string' } },
            { name: 'carrier', in: 'query', description: 'DHL, UPS or CTT.', schema: { type: 'string' } },
            { name: 'shipped_since', in: 'query', description: 'ISO date; only shipments that left on or after it.', schema: { type: 'string', format: 'date' } },
            { name: 'limit', in: 'query', description: 'Page size, max 100 (default 50).', schema: { type: 'integer' } },
          ],
          responses: { '200': json('ShipmentList') },
        },
        post: {
          operationId: 'logistics_create_shipment',
          tags: ['Shipments'],
          summary: 'Create a shipment',
          description: 'Create an outbound shipment, e.g. a free replacement for a damaged or lost parcel. Books the carrier pickup for the next cutoff.',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewShipment' } } } },
          responses: { '201': json('Shipment', 'Created') },
        },
      },
      '/shipments/{shipment_id}': {
        get: {
          operationId: 'logistics_get_shipment',
          tags: ['Shipments'],
          summary: 'Get a shipment',
          parameters: [idParam('shipment_id', 'Shipment id, e.g. SHP-556981.')],
          responses: { '200': json('Shipment') },
        },
      },
      '/shipments/{shipment_id}/events': {
        get: {
          operationId: 'logistics_list_shipment_events',
          tags: ['Tracking'],
          summary: 'Tracking timeline of a shipment',
          parameters: [idParam('shipment_id', 'Shipment id.')],
          responses: { '200': json('EventList') },
        },
      },
      '/shipments/{shipment_id}/cancel': {
        post: {
          operationId: 'logistics_cancel_shipment',
          tags: ['Shipments'],
          summary: 'Cancel a shipment that has not been picked up yet',
          parameters: [idParam('shipment_id', 'Shipment id.')],
          responses: { '200': json('Shipment') },
        },
      },
      '/shipments/{shipment_id}/claims': {
        post: {
          operationId: 'logistics_open_carrier_claim',
          tags: ['Shipments'],
          summary: 'Open a damage or loss claim with the carrier',
          parameters: [idParam('shipment_id', 'Shipment id.')],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: ['damage', 'loss'] }, note: { type: 'string' } } } } },
          },
          responses: { '201': json('Claim', 'Created') },
        },
      },
      '/orders/{order_ref}/shipments': {
        get: {
          operationId: 'logistics_find_shipments_by_order',
          tags: ['Shipments'],
          summary: 'Shipments of one order',
          parameters: [idParam('order_ref', 'Order reference, e.g. ETSY-3401556981.')],
          responses: { '200': json('ShipmentList') },
        },
      },
      '/tracking/{tracking_number}': {
        get: {
          operationId: 'logistics_track_parcel',
          tags: ['Tracking'],
          summary: 'Track a parcel by carrier tracking number',
          parameters: [idParam('tracking_number', 'Carrier tracking number, as shown on the Etsy receipt.')],
          responses: { '200': json('Shipment') },
        },
      },
      '/carriers': {
        get: { operationId: 'logistics_list_carriers', tags: ['Carriers'], summary: 'Carriers and their services', responses: { '200': json('CarrierList') } },
      },
      '/rates': {
        post: {
          operationId: 'logistics_quote_rates',
          tags: ['Carriers'],
          summary: 'Quote shipping rates',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['from_warehouse', 'to_country'],
                  properties: { from_warehouse: { type: 'string' }, to_country: { type: 'string' }, weight_kg: { type: 'number' } },
                },
              },
            },
          },
          responses: { '200': json('RateList') },
        },
      },
      '/warehouses': {
        get: {
          operationId: 'logistics_list_warehouses',
          tags: ['Warehouses'],
          summary: 'Warehouses and their SAP plants',
          description: 'LIS-1 is SAP plant 1000 (Lisbon Studio), OPO-1 is SAP plant 1100 (Porto Warehouse).',
          responses: { '200': json('WarehouseList') },
        },
      },
      '/returns': {
        get: { operationId: 'logistics_list_returns', tags: ['Returns'], summary: 'Returns on their way back or received', responses: { '200': json('ReturnList') } },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Key from the Lumen Logistics dashboard.' },
      },
      schemas: {
        Shipment: {
          type: 'object',
          properties: {
            shipment_id: { type: 'string' },
            order_ref: { type: 'string' },
            status: { type: 'string', enum: ['in_transit', 'delivered', 'delayed', 'lost'] },
            is_late: { type: 'boolean' },
            carrier: { type: 'string' },
            tracking_number: { type: 'string' },
            origin_warehouse: { type: 'string' },
            destination: { type: 'object', properties: { name: { type: 'string' }, city: { type: 'string' }, country: { type: 'string' } } },
            items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'integer' } } } },
            shipped_at: { type: ['string', 'null'], format: 'date-time' },
            estimated_delivery: { type: ['string', 'null'], format: 'date-time' },
            delivered_at: { type: ['string', 'null'], format: 'date-time' },
            issue: { type: ['object', 'null'], properties: { code: { type: 'string' }, summary: { type: 'string' }, last_location: { type: 'string' }, last_scan_at: { type: 'string' } } },
          },
        },
        NewShipment: {
          type: 'object',
          required: ['order_ref', 'from_warehouse', 'items'],
          properties: {
            order_ref: { type: 'string' },
            from_warehouse: { type: 'string', description: 'LIS-1 or OPO-1.' },
            reason: { type: 'string', enum: ['replacement', 'new_order'] },
            items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'integer' } } } },
          },
        },
        ShipmentList: { type: 'object', properties: { count: { type: 'integer' }, results: { type: 'array', items: { $ref: '#/components/schemas/Shipment' } } } },
        EventList: { type: 'object', properties: { shipment_id: { type: 'string' }, events: { type: 'array', items: { type: 'object' } } } },
        Claim: { type: 'object', properties: { claim_id: { type: 'string' }, shipment_id: { type: 'string' }, type: { type: 'string' }, status: { type: 'string' } } },
        CarrierList: { type: 'object', properties: { results: { type: 'array', items: { type: 'object' } } } },
        RateList: { type: 'object', properties: { results: { type: 'array', items: { type: 'object' } } } },
        WarehouseList: { type: 'object', properties: { results: { type: 'array', items: { type: 'object' } } } },
        ReturnList: { type: 'object', properties: { results: { type: 'array', items: { type: 'object' } } } },
      },
    },
  };
}
