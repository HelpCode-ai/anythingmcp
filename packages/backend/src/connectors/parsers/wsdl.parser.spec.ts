import * as path from 'path';
import axios from 'axios';
import { WsdlParser } from './wsdl.parser';
import { SoapEngine } from '../engines/soap.engine';

// The soap library reads a local path from disk, so the fixtures are parsed
// for real; only the SOAP call itself is intercepted. The SSRF guard is off
// under Jest (see ssrf.util readPolicy).
const fixture = (name: string) =>
  path.join(__dirname, '__fixtures__', 'wsdl', `${name}.wsdl`);

describe('WsdlParser', () => {
  let parser: WsdlParser;
  let engine: SoapEngine;
  let post: jest.SpyInstance;

  beforeEach(() => {
    parser = new WsdlParser();
    engine = new SoapEngine();
    post = jest.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: '<Envelope><Body><GetItemResponse><name>Chair</name></GetItemResponse></Body></Envelope>',
    });
  });

  afterEach(() => {
    post.mockRestore();
  });

  /** Run the imported tool through the engine and return the envelope it sent. */
  async function envelopeFor(
    wsdl: string,
    endpointMapping: Record<string, any>,
  ): Promise<string> {
    await engine.execute(
      {
        baseUrl: 'http://items.example.com/soap',
        authType: 'NONE',
        specUrl: wsdl,
      },
      endpointMapping as any,
      { itemId: 7, language: 'en' },
    );
    return post.mock.calls[0][1] as string;
  }

  describe('document/literal, input element named after the operation (WCF)', () => {
    it('stores the usual mapping, without inputElement', async () => {
      const [tool] = await parser.parse(fixture('wrapped-operation-name'));

      expect(tool.endpointMapping).toEqual({
        method: 'GetItem',
        path: 'BasicHttpBinding_IItemService',
        bodyMapping: { itemId: '$itemId', language: '$language' },
        paramOrder: ['itemId', 'language'],
        soapAction: 'http://tempuri.org/IItemService/GetItem',
        endpoint: 'http://items.example.com/ItemService.svc',
        targetNamespace: 'http://tempuri.org/',
      });
    });

    it('wraps the parameters in <tns:GetItem>', async () => {
      const wsdl = fixture('wrapped-operation-name');
      const [tool] = await parser.parse(wsdl);
      const envelope = await envelopeFor(wsdl, tool.endpointMapping);

      expect(envelope).toContain('xmlns:tns="http://tempuri.org/"');
      expect(envelope).toContain(
        [
          '    <tns:GetItem>',
          '      <tns:itemId>7</tns:itemId>',
          '      <tns:language>en</tns:language>',
          '    </tns:GetItem>',
        ].join('\n'),
      );
    });
  });

  describe('document/literal, input element GetItemRequest for operation GetItem', () => {
    it('stores the input element and its namespace', async () => {
      const [tool] = await parser.parse(fixture('request-element'));

      expect(tool.endpointMapping).toEqual({
        method: 'GetItem',
        path: 'ItemPort',
        bodyMapping: { itemId: '$itemId', language: '$language' },
        paramOrder: ['itemId', 'language'],
        endpoint: 'http://items.example.com/soap',
        targetNamespace: 'http://example.com/items/wsdl',
        inputElement: 'GetItemRequest',
        inputNamespace: 'http://example.com/items/schema',
      });
    });

    it('sends <tns:GetItemRequest> in the schema namespace', async () => {
      const wsdl = fixture('request-element');
      const [tool] = await parser.parse(wsdl);
      const envelope = await envelopeFor(wsdl, tool.endpointMapping);

      expect(envelope).toBe(`<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://example.com/items/schema">
  <soapenv:Header/>
  <soapenv:Body>
    <tns:GetItemRequest>
      <tns:itemId>7</tns:itemId>
      <tns:language>en</tns:language>
    </tns:GetItemRequest>
  </soapenv:Body>
</soapenv:Envelope>`);
      expect(envelope).not.toContain('<tns:GetItem>');
    });

    it('picks the input element from the WSDL for a tool imported before it was stored', async () => {
      // An older import of the same WSDL: no inputElement/inputNamespace, and
      // no soapAction (empty in this WSDL), so the engine reads the WSDL.
      const wsdl = fixture('request-element');
      const envelope = await envelopeFor(wsdl, {
        method: 'GetItem',
        path: 'ItemPort',
        bodyMapping: { itemId: '$itemId', language: '$language' },
        paramOrder: ['itemId', 'language'],
        endpoint: 'http://items.example.com/soap',
        targetNamespace: 'http://example.com/items/wsdl',
      });

      expect(envelope).toContain('xmlns:tns="http://example.com/items/schema"');
      expect(envelope).toContain('<tns:GetItemRequest>');
    });
  });

  describe('rpc/literal', () => {
    it('keeps the operation name as the wrapper and reads the soapAction through the binding', async () => {
      const wsdl = fixture('rpc-literal');
      const [tool] = await parser.parse(wsdl);

      expect(tool.endpointMapping).toEqual({
        method: 'GetItem',
        path: 'ItemRpcPort',
        bodyMapping: { itemId: '$itemId', language: '$language' },
        paramOrder: ['itemId', 'language'],
        soapAction: 'urn:GetItem',
        endpoint: 'http://items.example.com/rpc',
        targetNamespace: 'http://example.com/items/rpc',
        childElementsQualified: false,
      });

      const envelope = await envelopeFor(wsdl, tool.endpointMapping);
      expect(envelope).toContain('<tns:GetItem>');
    });

    it('writes the message parts unqualified', async () => {
      const wsdl = fixture('rpc-literal');
      const [tool] = await parser.parse(wsdl);
      const envelope = await envelopeFor(wsdl, tool.endpointMapping);

      expect(envelope).toContain(
        [
          '    <tns:GetItem>',
          '      <itemId>7</itemId>',
          '      <language>en</language>',
          '    </tns:GetItem>',
        ].join('\n'),
      );
    });
  });

  describe('element qualification', () => {
    it('writes the children unqualified for elementFormDefault="unqualified" (the XSD default), without a default namespace', async () => {
      const wsdl = fixture('jaxws-unqualified');
      const [tool] = await parser.parse(wsdl);
      expect(tool.endpointMapping).toMatchObject({ childElementsQualified: false });

      await engine.execute(
        { baseUrl: 'http://orders.example.com/OrderService', authType: 'NONE', specUrl: wsdl },
        tool.endpointMapping as any,
        { customerId: 'C-1', address: { street: 'Main St 1', city: 'Basel' } },
      );
      const envelope = post.mock.calls[0][1] as string;

      expect(envelope).toContain(
        [
          '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://example.com/orders">',
          '  <soapenv:Header/>',
          '  <soapenv:Body>',
          '    <tns:createOrder>',
          '      <customerId>C-1</customerId>',
          '      <address>',
          '        <street>Main St 1</street>',
          '        <city>Basel</city>',
          '      </address>',
          '    </tns:createOrder>',
        ].join('\n'),
      );
      // Unprefixed elements must be in no namespace: no default xmlns anywhere.
      expect(envelope).not.toMatch(/xmlns=/);
    });

    it('keeps WCF children (elementFormDefault="qualified") qualified and stores nothing new', async () => {
      const [tool] = await parser.parse(fixture('wrapped-operation-name'));
      expect(tool.endpointMapping).not.toHaveProperty('childElementsQualified');
    });

    const inlineWsdl = (schemaAttrs: string, elements: string) => `<?xml version="1.0" encoding="utf-8"?>
<definitions name="S" targetNamespace="urn:s" xmlns="http://schemas.xmlsoap.org/wsdl/"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:s">
  <types>
    <xs:schema targetNamespace="urn:s" ${schemaAttrs}>
      <xs:element name="Op"><xs:complexType><xs:sequence>${elements}</xs:sequence></xs:complexType></xs:element>
      <xs:element name="OpResponse"><xs:complexType><xs:sequence/></xs:complexType></xs:element>
    </xs:schema>
  </types>
  <message name="OpIn"><part name="parameters" element="tns:Op"/></message>
  <message name="OpOut"><part name="parameters" element="tns:OpResponse"/></message>
  <portType name="PT"><operation name="Op"><input message="tns:OpIn"/><output message="tns:OpOut"/></operation></portType>
  <binding name="B" type="tns:PT">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Op"><soap:operation soapAction="urn:Op"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
  </binding>
  <service name="S"><port name="P" binding="tns:B"><soap:address location="http://s.example.com/"/></port></service>
</definitions>`;

    it.each([
      [
        'form="unqualified" on every child of a qualified schema',
        'elementFormDefault="qualified"',
        '<xs:element name="a" type="xs:string" form="unqualified"/><xs:element name="b" type="xs:int" form="unqualified"/>',
        false,
      ],
      [
        'form="qualified" on every child of an unqualified schema',
        '',
        '<xs:element name="a" type="xs:string" form="qualified"/><xs:element name="b" type="xs:int" form="qualified"/>',
        undefined,
      ],
      [
        'qualified and unqualified children mixed (kept as before)',
        '',
        '<xs:element name="a" type="xs:string" form="qualified"/><xs:element name="b" type="xs:int"/>',
        undefined,
      ],
    ])('reads %s', async (_label, schemaAttrs, elements, expected) => {
      const [tool] = await parser.parse(inlineWsdl(schemaAttrs, elements));
      expect((tool.endpointMapping as any).childElementsQualified).toBe(expected);
    });
  });

  describe('SOAP 1.2 ports', () => {
    it('marks the tools of a SOAP 1.2 port and calls them with SOAP 1.2', async () => {
      const wsdl = fixture('soap12-only');
      const tools = await parser.parse(wsdl);

      expect(tools).toHaveLength(1);
      expect(tools[0].endpointMapping).toEqual({
        method: 'GetStock',
        path: 'StockSoap12Port',
        bodyMapping: { sku: '$sku' },
        paramOrder: ['sku'],
        soapAction: 'urn:GetStock',
        endpoint: 'http://stock.example.com/soap12',
        targetNamespace: 'http://example.com/stock',
        soapVersion: '1.2',
      });

      await engine.execute(
        { baseUrl: 'http://stock.example.com/soap12', authType: 'NONE', specUrl: wsdl },
        tools[0].endpointMapping as any,
        { sku: 'A-1' },
      );
      const [, envelope, options] = post.mock.calls[0];
      expect(envelope).toContain(
        '<soapenv:Envelope xmlns:soapenv="http://www.w3.org/2003/05/soap-envelope" xmlns:tns="http://example.com/stock">',
      );
      expect(options.headers['Content-Type']).toBe(
        'application/soap+xml; charset=utf-8; action="urn:GetStock"',
      );
      expect(options.headers).not.toHaveProperty('SOAPAction');
    });

    it('keeps only the SOAP 1.1 tool of an operation offered on both, whatever the port order', async () => {
      const wsdl = fixture('soap11-and-soap12');
      const tools = await parser.parse(wsdl);

      // Both ports would give "itemservice_getitem"; the SOAP 1.2 port comes
      // first in the WSDL.
      expect(tools.map((t) => t.name)).toEqual(['itemservice_getitem']);
      expect(tools[0].endpointMapping).toEqual({
        method: 'GetItem',
        path: 'BasicHttpBinding_IItemService',
        bodyMapping: { itemId: '$itemId' },
        paramOrder: ['itemId'],
        soapAction: 'http://tempuri.org/IItemService/GetItem',
        endpoint: 'http://items.example.com/ItemService.svc',
        targetNamespace: 'http://tempuri.org/',
      });
    });

    it('counts the ports of both versions in a connection test', async () => {
      await expect(engine.inspectWsdl(fixture('soap11-and-soap12'))).resolves.toEqual({
        operations: 1,
        ports: 2,
        soap12Ports: 1,
      });
      expect(post).not.toHaveBeenCalled();
    });

    it('does not mark SOAP 1.1 ports', async () => {
      for (const name of ['wrapped-operation-name', 'request-element', 'rpc-literal', 'jaxws-unqualified']) {
        const tools = await parser.parse(fixture(name));
        for (const tool of tools) expect(tool.endpointMapping).not.toHaveProperty('soapVersion');
      }
    });
  });

  describe('required and optional parameters', () => {
    it('makes WCF parameters with minOccurs="0" optional, leaving the rest of the tool as before', async () => {
      const [tool] = await parser.parse(fixture('wrapped-operation-name'));

      expect(tool.parameters).toEqual({
        type: 'object',
        properties: {
          itemId: { type: 'number', description: 'SOAP parameter: itemId (xs:int)' },
          language: { type: 'string', description: 'SOAP parameter: language (xs:string)' },
        },
      });
    });

    it('keeps elements without minOccurs required', async () => {
      const [tool] = await parser.parse(fixture('request-element'));
      expect((tool.parameters as any).required).toEqual(['itemId', 'language']);
    });

    it('keeps RPC parts required (they have no minOccurs)', async () => {
      const [tool] = await parser.parse(fixture('rpc-literal'));
      expect((tool.parameters as any).required).toEqual(['itemId', 'language']);
    });

    it('reads a JAX-WS schema: optional elements, enumerations, dates, no describe() metadata', async () => {
      const [tool] = await parser.parse(fixture('jaxws-unqualified'));

      expect(tool.parameters).toEqual({
        type: 'object',
        properties: {
          customerId: { type: 'string', description: 'SOAP parameter: customerId (xs:string)' },
          status: {
            type: 'string',
            enum: ['NEW', 'SHIPPED'],
            description: 'SOAP parameter: status (orderStatus|xs:string|NEW,SHIPPED)',
          },
          deliveryDate: {
            type: 'string',
            format: 'date-time',
            description: 'SOAP parameter: deliveryDate (xs:dateTime)',
          },
          address: {
            type: 'object',
            properties: { street: { type: 'string' }, city: { type: 'string' } },
            additionalProperties: true,
            description: 'SOAP parameter: address (complex type)',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'SOAP parameter: tags (xs:string), repeated: pass a list',
          },
          // nillable, but without minOccurs="0": it must be sent.
          note: { type: 'string', description: 'SOAP parameter: note (xs:string)' },
        },
        required: ['customerId', 'note'],
      });
      expect(tool.endpointMapping).toEqual({
        method: 'createOrder',
        path: 'OrderServicePort',
        bodyMapping: {
          customerId: '$customerId',
          status: '$status',
          deliveryDate: '$deliveryDate',
          address: '$address',
          tags: '$tags',
          note: '$note',
        },
        paramOrder: ['customerId', 'status', 'deliveryDate', 'address', 'tags', 'note'],
        endpoint: 'http://orders.example.com/OrderService',
        targetNamespace: 'http://example.com/orders',
        elementOrder: { address: ['street', 'city'] },
        childElementsQualified: false,
      });
    });

    const inlineWsdl = (content: string) => `<?xml version="1.0" encoding="utf-8"?>
<definitions name="S" targetNamespace="urn:s" xmlns="http://schemas.xmlsoap.org/wsdl/"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xs="http://www.w3.org/2001/XMLSchema"
    xmlns:tns="urn:s" xmlns:ext="urn:not-in-this-wsdl">
  <types>
    <xs:schema targetNamespace="urn:s" elementFormDefault="qualified">
      <xs:element name="Op"><xs:complexType>${content}</xs:complexType></xs:element>
      <xs:element name="OpResponse"><xs:complexType><xs:sequence/></xs:complexType></xs:element>
    </xs:schema>
  </types>
  <message name="OpIn"><part name="parameters" element="tns:Op"/></message>
  <message name="OpOut"><part name="parameters" element="tns:OpResponse"/></message>
  <portType name="PT"><operation name="Op"><input message="tns:OpIn"/><output message="tns:OpOut"/></operation></portType>
  <binding name="B" type="tns:PT">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Op"><soap:operation soapAction="urn:Op"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
  </binding>
  <service name="S"><port name="P" binding="tns:B"><soap:address location="http://s.example.com/"/></port></service>
</definitions>`;

    it('makes the elements of a choice, or of an optional group, optional', async () => {
      const [tool] = await parser.parse(
        inlineWsdl(`<xs:sequence>
          <xs:element name="id" type="xs:string"/>
          <xs:choice><xs:element name="byName" type="xs:string"/><xs:element name="byCode" type="xs:string"/></xs:choice>
          <xs:sequence minOccurs="0"><xs:element name="page" type="xs:int"/></xs:sequence>
        </xs:sequence>`),
      );
      expect(Object.keys((tool.parameters as any).properties)).toEqual(['id', 'byName', 'byCode', 'page']);
      expect((tool.parameters as any).required).toEqual(['id']);
    });

    it('keeps every parameter required when the schema cannot be resolved', async () => {
      const [tool] = await parser.parse(
        inlineWsdl(`<xs:complexContent><xs:extension base="ext:Base"><xs:sequence>
          <xs:element name="a" type="xs:string" minOccurs="0"/>
        </xs:sequence></xs:extension></xs:complexContent>`),
      );
      expect((tool.parameters as any).required).toEqual(['a']);
      expect(tool.endpointMapping).not.toHaveProperty('childElementsQualified');
    });

    it('reads the elements an extension inherits from its base type', async () => {
      const wsdl = inlineWsdl(`<xs:complexContent><xs:extension base="tns:Base"><xs:sequence>
          <xs:element name="own" type="xs:string" minOccurs="0"/>
        </xs:sequence></xs:extension></xs:complexContent>`).replace(
        '<xs:element name="OpResponse">',
        `<xs:complexType name="Base"><xs:sequence>
          <xs:element name="inherited" type="xs:string"/>
        </xs:sequence></xs:complexType>
        <xs:element name="OpResponse">`,
      );
      const [tool] = await parser.parse(wsdl);
      expect((tool.parameters as any).required).toEqual(['inherited']);
    });
  });

  describe('complex and repeated parameters (JAX-WS)', () => {
    it('describes a complex parameter as an object and a repeated one as an array', async () => {
      const [tool] = await parser.parse(fixture('jaxws-unqualified'));
      const properties = (tool.parameters as any).properties;

      expect(properties.address).toEqual({
        type: 'object',
        properties: { street: { type: 'string' }, city: { type: 'string' } },
        additionalProperties: true,
        description: 'SOAP parameter: address (complex type)',
      });
      expect(properties.tags).toEqual({
        type: 'array',
        items: { type: 'string' },
        description: 'SOAP parameter: tags (xs:string), repeated: pass a list',
      });
      expect(properties).not.toHaveProperty(['tags[]']);
      expect(tool.endpointMapping).toMatchObject({
        elementOrder: { address: ['street', 'city'] },
      });
      expect((tool.endpointMapping as any).paramOrder).toContain('tags');
      expect((tool.endpointMapping as any).bodyMapping).toMatchObject({ tags: '$tags' });
    });

    it('sends the nested values in schema order', async () => {
      const wsdl = fixture('jaxws-unqualified');
      const [tool] = await parser.parse(wsdl);

      await engine.execute(
        { baseUrl: 'http://orders.example.com/OrderService', authType: 'NONE', specUrl: wsdl },
        tool.endpointMapping as any,
        {
          customerId: 'C-1',
          address: { city: 'Basel', street: 'Main St 1' },
          tags: ['urgent', 'b2b'],
        },
      );
      const envelope = post.mock.calls[0][1] as string;

      expect(envelope).toMatch(
        /<(tns:)?address>\s*<(tns:)?street>Main St 1<\/(tns:)?street>\s*<(tns:)?city>Basel<\/(tns:)?city>\s*<\/(tns:)?address>/,
      );
      expect(envelope).toMatch(/<(tns:)?tags>urgent<\/(tns:)?tags>\s*<(tns:)?tags>b2b<\/(tns:)?tags>/);
    });
  });

  it('keeps the envelope of a tool with complete metadata unchanged and does not read the WSDL', async () => {
    const createClient = jest.spyOn(require('soap'), 'createClientAsync');
    const envelope = await envelopeFor('http://unused.example.com/?wsdl', {
      method: 'GetItem',
      path: 'BasicHttpBinding_IItemService',
      bodyMapping: { itemId: '$itemId', language: '$language' },
      paramOrder: ['itemId', 'language'],
      soapAction: 'http://tempuri.org/IItemService/GetItem',
      endpoint: 'http://items.example.com/ItemService.svc',
      targetNamespace: 'http://tempuri.org/',
    });

    expect(createClient).not.toHaveBeenCalled();
    createClient.mockRestore();
    expect(envelope).toBe(`<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://tempuri.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <tns:GetItem>
      <tns:itemId>7</tns:itemId>
      <tns:language>en</tns:language>
    </tns:GetItem>
  </soapenv:Body>
</soapenv:Envelope>`);
    expect(post.mock.calls[0][0]).toBe('http://items.example.com/ItemService.svc');
    expect(post.mock.calls[0][2].headers).toEqual({
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: 'http://tempuri.org/IItemService/GetItem',
    });
  });

  describe('stored tools without the fields this import adds', () => {
    // Tools imported before soapVersion and childElementsQualified existed
    // lack them. When their metadata is incomplete the engine reads the WSDL
    // at call time, but must not opt them in from it: they keep sending
    // what they sent before.
    it('a tool on a SOAP 1.2 port still sends SOAP 1.1', async () => {
      const wsdl = fixture('soap12-only');
      await engine.execute(
        { baseUrl: 'http://stock.example.com/soap12', authType: 'NONE', specUrl: wsdl },
        {
          method: 'GetStock',
          path: 'StockSoap12Port',
          bodyMapping: { sku: '$sku' },
          paramOrder: ['sku'],
          // no soapAction stored: read from the WSDL at call time
          endpoint: 'http://stock.example.com/soap12',
          targetNamespace: 'http://example.com/stock',
        },
        { sku: 'A-1' },
      );
      const [, envelope, options] = post.mock.calls[0];
      expect(envelope).toContain('xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"');
      expect(options.headers).toEqual({
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: 'urn:GetStock',
      });
    });

    it('a JAX-WS tool still sends qualified elements, as stored by the old import', async () => {
      const wsdl = fixture('jaxws-unqualified');
      await engine.execute(
        { baseUrl: 'http://orders.example.com/OrderService', authType: 'NONE', specUrl: wsdl },
        {
          method: 'createOrder',
          path: 'OrderServicePort',
          bodyMapping: {
            customerId: '$customerId',
            note: '$note',
            targetNSAlias: '$targetNSAlias',
            targetNamespace: '$targetNamespace',
          },
          paramOrder: ['customerId', 'note', 'targetNSAlias', 'targetNamespace'],
          endpoint: 'http://orders.example.com/OrderService',
          targetNamespace: 'http://example.com/orders',
        },
        { customerId: 'C-1', note: 'n', targetNSAlias: 'tns', targetNamespace: 'urn:x' },
      );
      const [, envelope, options] = post.mock.calls[0];
      expect(envelope).toBe(`<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://example.com/orders">
  <soapenv:Header/>
  <soapenv:Body>
    <tns:createOrder>
      <tns:customerId>C-1</tns:customerId>
      <tns:note>n</tns:note>
      <tns:targetNSAlias>tns</tns:targetNSAlias>
      <tns:targetNamespace>urn:x</tns:targetNamespace>
    </tns:createOrder>
  </soapenv:Body>
</soapenv:Envelope>`);
      // The WSDL's soapAction is empty: SOAP 1.1 requires the header anyway.
      expect(options.headers).toEqual({ 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' });
    });
  });
});
