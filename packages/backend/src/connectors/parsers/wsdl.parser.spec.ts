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
  });
});
