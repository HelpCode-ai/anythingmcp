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
      });

      const envelope = await envelopeFor(wsdl, tool.endpointMapping);
      expect(envelope).toContain('<tns:GetItem>');
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
