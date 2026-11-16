import * as adapter from './mercari-shops.json';
import { Kind, OperationDefinitionNode, parse } from 'graphql';
/**
 * mercari shops API adapter (GraphQL, Japan).
 *
 * Static checks always run: the Bearer personal access token and the contract
 * User-Agent on https://api.mercari-shops.com/v1/graphql, that every document parses,
 * declares exactly the variables it sends and requires the non-null ones (operation and
 * field names from the reference at https://api.mercari-shops.com/docs/index.html), that
 * the generic mutation tool and cancelling or deleting install switched off, and that the
 * adapter is self-hosted only (Mercari accepts only registered fixed Japanese IP addresses).
 *
 * Live checks run only with RUN_MERCARI_SHOPS_LIVE=1 and MERCARI_SHOPS_API_TOKEN,
 * MERCARI_SHOPS_USER_AGENT set, from a registered IP address: they read the shop and one
 * order transaction. Reads only.
 *
 *   RUN_MERCARI_SHOPS_LIVE=1 MERCARI_SHOPS_API_TOKEN=... MERCARI_SHOPS_USER_AGENT=NAME/1.0.0 \
 *     npx jest src/adapters/jp/mercari-shops.live.spec.ts
 */
type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, unknown>;
  bodyMapping?: unknown;
  headers?: Record<string, string>;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; pattern?: string }>; required?: string[] };
  endpointMapping: Mapping;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  description: string;
  selfHostOnly?: boolean;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string; label?: string; help?: string; options?: { value: string; label: string }[] }>;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string): Tool => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const refs = (value: unknown, out: Set<string> = new Set<string>()): Set<string> => {
  if (typeof value === 'string') {
    if (/^\$\w+$/.test(value)) out.add(value.slice(1));
  } else if (Array.isArray(value)) {
    value.forEach((item) => refs(item, out));
  } else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => refs(item, out));
  }
  return out;
};
const outsideBackticks = (text: string): string => text.replace(/`[^`]*`/g, '');

const ROUTES: Record<string, [string, string]> = {
  mercari_shops_get_shop: ["query", "query Shop { shop { id name description shopStatus businessKind enableMultiplePurchase createdAt } }"],
  mercari_shops_list_products: ["query", "query Products($first: Int, $after: String, $keyword: String) { products(first: $first, after: $after, keyword: $keyword) { edges { node { id name description price status condition orderType imageUrls shippingMethod shippingPayer shippingDuration shippingFromState { id name } shippingConfiguration { id title } categories { id name parentId } brand { id name } variants { id name skuCode janCode stockQuantity maxQuantityPerOrder } createdAt updatedAt } } pageInfo { endCursor hasNextPage } } }"],
  mercari_shops_get_product: ["query", "query Product($id: String!) { product(id: $id) { id name description price status condition orderType imageUrls shippingMethod shippingPayer shippingDuration shippingFromState { id name } shippingConfiguration { id title } categories { id name parentId } brand { id name } variants { id name skuCode janCode stockQuantity maxQuantityPerOrder } createdAt updatedAt } }"],
  mercari_shops_get_product_variant: ["query", "query ProductVariant($by: ProductVariantBy!) { productVariant(by: $by) { id name skuCode janCode stockQuantity maxQuantityPerOrder product { id name status price } } }"],
  mercari_shops_get_listing_options: ["query", "query ListingOptions { availableProductConditionOptions { name type } availableShippingMethodOptions { name type } availableShippingDurationOptions { name type } availableShippingPayerOptions { name type } states { id name } }"],
  mercari_shops_list_product_categories: ["query", "query ProductCategories { productCategories { id name parentId hasChild } }"],
  mercari_shops_list_shipping_configurations: ["query", "query ShippingConfigurations($first: Int, $after: String) { productShippingConfigurations(first: $first, after: $after) { edges { node { id displayId title type createdAt updatedAt } } pageInfo { endCursor hasNextPage } } }"],
  mercari_shops_list_order_transactions: ["query", "query OrderTransactions($first: Int, $after: String, $statuses: [OrderTransactionStatusFilter!], $orderedDateGte: DateTime, $orderedDateLt: DateTime, $updatedDateGte: DateTime, $updatedDateLt: DateTime) { orderTransactions(first: $first, after: $after, statuses: $statuses, orderedDateGte: $orderedDateGte, orderedDateLt: $orderedDateLt, updatedDateGte: $updatedDateGte, updatedDateLt: $updatedDateLt) { edges { node { id status orderType salesChannel cancelable isPartialCancelable createdAt updatedAt paidAt paymentDeadline completedAt canceledAt paymentMethod totalPrice salesFee unifiedShippingFee refundableUnifiedShippingFee preOrderStatus userInfo { nickname } shippingAddress { firstName lastName firstNameKana lastNameKana postalCode state { id name } city address1 address2 country phoneNumber } products { productId name unitPrice purchasedQuantity buyerShippingFee shippingMethod unshippedQuantity shippingCreatedQuantity shippingCompletedQuantity unshippedCanceledQuantity shippedCanceledQuantity variant { id name skuCode janCode } } } } pageInfo { endCursor hasNextPage } } }"],
  mercari_shops_get_order_transaction: ["query", "query OrderTransaction($id: ID!) { orderTransaction(id: $id) { id status orderType salesChannel cancelable isPartialCancelable createdAt updatedAt paidAt paymentDeadline completedAt canceledAt paymentMethod totalPrice salesFee unifiedShippingFee refundableUnifiedShippingFee preOrderStatus userInfo { nickname } shippingAddress { firstName lastName firstNameKana lastNameKana postalCode state { id name } city address1 address2 country phoneNumber } products { productId name unitPrice purchasedQuantity buyerShippingFee shippingMethod unshippedQuantity shippingCreatedQuantity shippingCompletedQuantity unshippedCanceledQuantity shippedCanceledQuantity variant { id name skuCode janCode } } } }"],
  mercari_shops_list_order_shippings: ["query", "query OrderShippings($orderTransactionId: ID, $first: Int, $after: String) { orderShippings(orderTransactionId: $orderTransactionId, first: $first, after: $after) { edges { node { id status shippingMethod trackingCode sellerShippingFee createdAt shippedAt completedAt updatedAt products { productId quantity shippingQuantity shippedQuantity canceledQuantity buyerShippingFee variant { id name skuCode } } } } pageInfo { endCursor hasNextPage } } }"],
  mercari_shops_list_order_cancellations: ["query", "query OrderCancellations($orderTransactionId: ID!, $first: Int, $after: String) { orderCancellations(orderTransactionId: $orderTransactionId, first: $first, after: $after) { edges { node { id status cancelReasonType productRefundAmount shippingFeeRefundAmount paymentFeeRefundAmount createdAt canceledAt products { productId quantity orderShippingId variant { id skuCode } } } } pageInfo { endCursor hasNextPage } } }"],
  mercari_shops_create_order_shipping: ["mutation", "mutation CreateOrderShipping($input: CreateOrderShippingInput!) { createOrderShipping(input: $input) { orderShipping { id status shippingMethod trackingCode sellerShippingFee createdAt shippedAt completedAt updatedAt products { productId quantity shippingQuantity shippedQuantity canceledQuantity buyerShippingFee variant { id name skuCode } } } } }"],
  mercari_shops_update_shipping_tracking_code: ["mutation", "mutation UpdateOrderShippingTrackingCode($orderTransactionId: String!, $orderShippingId: String!, $trackingCode: String!) { updateOrderShippingTrackingCode(input: { orderTransactionId: $orderTransactionId, orderShippingId: $orderShippingId, trackingCode: $trackingCode }) { orderShipping { id status trackingCode } } }"],
  mercari_shops_complete_order_shipping: ["mutation", "mutation CompleteOrderShipping($orderTransactionId: ID!, $orderShippingId: ID!) { completeOrderShipping(input: { orderTransactionId: $orderTransactionId, orderShippingId: $orderShippingId }) { orderShippingId } }"],
  mercari_shops_cancel_order_transaction: ["mutation", "mutation CancelOrderTransaction($orderTransactionId: ID!, $cancelReasonType: CancelReasonType!) { cancelOrderTransaction(input: { orderTransactionId: $orderTransactionId, cancelReasonType: $cancelReasonType }) { orderCancellation { id status cancelReasonType } orderTransaction { id status } } }"],
  mercari_shops_create_product: ["mutation", "mutation CreateProduct($input: CreateProductInput!) { createProduct(input: $input) { product { id name description price status condition orderType imageUrls shippingMethod shippingPayer shippingDuration shippingFromState { id name } shippingConfiguration { id title } categories { id name parentId } brand { id name } variants { id name skuCode janCode stockQuantity maxQuantityPerOrder } createdAt updatedAt } } }"],
  mercari_shops_update_product: ["mutation", "mutation UpdateProduct($input: UpdateProductInput!) { updateProduct(input: $input) { product { id name description price status condition orderType imageUrls shippingMethod shippingPayer shippingDuration shippingFromState { id name } shippingConfiguration { id title } categories { id name parentId } brand { id name } variants { id name skuCode janCode stockQuantity maxQuantityPerOrder } createdAt updatedAt } } }"],
  mercari_shops_update_variants: ["mutation", "mutation UpdateProductVariants($inputs: [UpdateProductVariantsInput!]!) { updateProductVariants(inputs: $inputs) { productVariants { id name skuCode janCode stockQuantity maxQuantityPerOrder } } }"],
  mercari_shops_delete_product: ["mutation", "mutation DeleteProduct($id: ID!) { deleteProduct(input: { id: $id }) { id } }"],
  mercari_shops_list_inquiries: ["query", "query Inquiries($first: Int, $after: String, $filter: ListInquiriesFilterInput, $sort: ListInquiriesSortInput) { inquiries(first: $first, after: $after, filter: $filter, sort: $sort) { edges { node { id status salesChannel firstOpenedAt lastActivityAt userInfo { nickname } target { __typename ... on InquiryOrderTransactionTarget { orderTransaction { id status } } ... on InquiryProductTarget { productId productVariantId } ... on InquiryShopTarget { shopId } } } } pageInfo { endCursor hasNextPage } } }"],
  mercari_shops_list_inquiry_messages: ["query", "query InquiryMessages($inquiryId: ID!, $first: Int, $after: String) { inquiryMessages(inquiryId: $inquiryId, first: $first, after: $after) { edges { node { id inquiryId body from sentAt status } } pageInfo { endCursor hasNextPage } } }"],
  mercari_shops_reply_to_inquiry: ["mutation", "mutation AddInquiryMessage($inquiryId: ID!, $body: String!, $idempotencyKey: String!) { addInquiryMessage(input: { inquiryId: $inquiryId, body: $body, idempotencyKey: $idempotencyKey }) { inquiryMessage { id body from sentAt status } } }"],
  mercari_shops_update_inquiry_status: ["mutation", "mutation UpdateInquiryStatus($inquiryId: ID!, $status: UpdatableInquiryStatus!) { updateInquiryStatus(input: { inquiryId: $inquiryId, status: $status }) { inquiry { id status lastActivityAt } } }"],
};
const SWITCHED_OFF = [
  "mercari_shops_cancel_order_transaction",
  "mercari_shops_delete_product"
];
const REQUIRED: Record<string, string[]> = {
  mercari_shops_get_shop: [],
  mercari_shops_list_products: [],
  mercari_shops_get_product: ["id"],
  mercari_shops_get_product_variant: ["by"],
  mercari_shops_get_listing_options: [],
  mercari_shops_list_product_categories: [],
  mercari_shops_list_shipping_configurations: [],
  mercari_shops_list_order_transactions: [],
  mercari_shops_get_order_transaction: ["id"],
  mercari_shops_list_order_shippings: ["order_transaction_id"],
  mercari_shops_list_order_cancellations: ["order_transaction_id"],
  mercari_shops_create_order_shipping: ["input"],
  mercari_shops_update_shipping_tracking_code: ["order_shipping_id", "order_transaction_id", "tracking_code"],
  mercari_shops_complete_order_shipping: ["order_shipping_id", "order_transaction_id"],
  mercari_shops_cancel_order_transaction: ["cancel_reason_type", "order_transaction_id"],
  mercari_shops_create_product: ["input"],
  mercari_shops_update_product: ["input"],
  mercari_shops_update_variants: ["inputs"],
  mercari_shops_delete_product: ["id"],
  mercari_shops_list_inquiries: [],
  mercari_shops_list_inquiry_messages: ["inquiry_id"],
  mercari_shops_reply_to_inquiry: ["body", "idempotency_key", "inquiry_id"],
  mercari_shops_update_inquiry_status: ["inquiry_id", "status"],
};
const PROBE = {"tool": "mercari_shops_get_shop", "params": {}};
const PROBE_METHOD = "query";

describe('mercari-shops adapter: static contract', () => {
  it('posts GraphQL with the Bearer token and the contract User-Agent, self-hosted only', () => {
    expect(a.slug).toBe('mercari-shops');
    expect(a.region).toBe('jp');
    expect(a.category).toBe('e-commerce');
    expect(a.selfHostOnly).toBe(true);
    expect(a.connector.type).toBe('GRAPHQL');
    expect(a.connector.baseUrl).toBe('https://api.mercari-shops.com/v1/graphql');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{MERCARI_SHOPS_API_TOKEN}}' });
    expect(a.connector.headers).toEqual({ 'User-Agent': '{{MERCARI_SHOPS_USER_AGENT}}' });
    expect(a.connector.config?.graphqlBuiltinsOff).toEqual(['mutation', 'subscription']);
    expect(a.requiredEnvVars).toEqual(['MERCARI_SHOPS_API_TOKEN', 'MERCARI_SHOPS_USER_AGENT']);
    expect(a.envVarMeta.MERCARI_SHOPS_API_TOKEN.secret).toBe(true);
    const ua = new RegExp(a.envVarMeta.MERCARI_SHOPS_USER_AGENT.pattern!);
    expect(ua.test('EXAMPLE_SHOP/1.0.0')).toBe(true);
    expect(ua.test('EXAMPLE_SHOP/2023-10-25')).toBe(true);
    expect(ua.test('EXAMPLE SHOP')).toBe(false);
  });

  it('pins the method and path of every tool', () => {
    const actual: Record<string, [string, string]> = {};
    for (const t of a.tools) actual[t.name] = [t.endpointMapping.method, t.endpointMapping.path];
    expect(actual).toEqual(ROUTES);
  });

  it('installs exactly the risky tools switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...SWITCHED_OFF].sort());
  });

  it('declares every variable it sends and wires every parameter into a variable', () => {
    for (const t of a.tools) {
      const op = parse(t.endpointMapping.path).definitions.find((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
      expect(`${t.name}:${op?.operation}`).toBe(`${t.name}:${t.endpointMapping.method}`);
      const declared = (op?.variableDefinitions ?? []).map((v) => v.variable.name.value).sort();
      expect(`${t.name}:${Object.keys(t.endpointMapping.queryParams ?? {}).sort().join(',')}`).toBe(`${t.name}:${declared.join(',')}`);
      const used = refs(t.endpointMapping.queryParams ?? {});
      for (const p of Object.keys(t.parameters.properties ?? {})) expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const r of t.parameters.required ?? []) expect(`${t.name}:${r}:${r in (t.parameters.properties ?? {})}`).toBe(`${t.name}:${r}:true`);
      for (const v of op?.variableDefinitions ?? []) {
        if (v.type.kind !== Kind.NON_NULL_TYPE || v.defaultValue) continue;
        const source = String((t.endpointMapping.queryParams ?? {})[v.variable.name.value] ?? '').replace(/^\$/, '');
        expect(`${t.name}:${source}:${(t.parameters.required ?? []).includes(source)}`).toBe(`${t.name}:${source}:true`);
      }
    }
  });

  it('pins the required parameters of every tool', () => {
    const actual: Record<string, string[]> = {};
    for (const t of a.tools) actual[t.name] = [...(t.parameters.required ?? [])].sort();
    expect(actual).toEqual(REQUIRED);
  });

  it('keeps parameter patterns compilable', () => {
    for (const t of a.tools) {
      for (const d of Object.values(t.parameters.properties ?? {})) if (d.pattern) expect(() => new RegExp(d.pattern as string)).not.toThrow();
    }
  });

  it('names every tool in the instructions, prefixes it with the slug and keeps the text MDX-safe', () => {
    const prefix = `${a.slug.replace(/-/g, '_')}_`;
    for (const t of a.tools) {
      expect(t.name.startsWith(prefix)).toBe(true);
      expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
      expect(outsideBackticks(t.description)).not.toMatch(/[{}<]/);
      for (const [p, d] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${Boolean(d.description)}`).toBe(`${t.name}.${p}:true`);
        expect(outsideBackticks(d.description ?? '')).not.toMatch(/[{}<]/);
      }
    }
    expect(outsideBackticks(a.instructions)).not.toMatch(/[{}<]/);
    expect(outsideBackticks(a.description)).not.toMatch(/[{}<]/);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });

  it('describes every variable and probes with a cheap read', () => {
    for (const v of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(a.envVarMeta[v]).toMatchObject({ label: expect.any(String), kind: expect.any(String), help: expect.any(String) });
    }
    expect(a.probe).toEqual(PROBE);
    expect(tool(a.probe.tool).endpointMapping.method).toBe(PROBE_METHOD);
    for (const status of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[status]).toBeDefined();
  });

  it('uses order transactions and inquiries, not the deprecated order and message APIs', () => {
    const docs = a.tools.map((t) => t.endpointMapping.path).join(' ');
    expect(docs).not.toMatch(/\borders\(|\border\(|addTransactionMessage|addOrderTransactionMessage|debug[A-Z]/);
    expect(tool('mercari_shops_create_order_shipping').endpointMapping.path).toMatch(/createOrderShipping\(input: \$input\)/);
    expect(tool('mercari_shops_update_variants').parameters.properties).toHaveProperty('inputs');
  });
});

const live = process.env.RUN_MERCARI_SHOPS_LIVE === '1' ? describe : describe.skip;
live('mercari-shops adapter: live reads', () => {
  it('reads the shop and one order transaction', async () => {
    for (const query of ['query { shop { id name shopStatus } }', 'query { orderTransactions(first: 1) { edges { node { id status } } } }']) {
      const res = await fetch('https://api.mercari-shops.com/v1/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.MERCARI_SHOPS_API_TOKEN}`,
          'User-Agent': `${process.env.MERCARI_SHOPS_USER_AGENT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { errors?: unknown }).errors).toBeUndefined();
    }
  });
});
