import { DAY_MS, PRODUCTS, dayAnchor } from './products';

/**
 * The SAP S/4HANA side of Lumen & Clay, served as SAP Gateway OData V2.
 *
 * The catalog lists a realistic set of standard services; three of them answer
 * with data: the custom stock overview (the one the demo queries), products
 * and sales orders. The others exist in the catalog only.
 */

export const PLANTS = {
  '1000': 'Lisbon Studio',
  '1100': 'Porto Warehouse',
} as const;

export interface StockRow {
  Material: string;
  MaterialName: string;
  Plant: keyof typeof PLANTS;
  PlantName: string;
  StorageLocation: string;
  UnrestrictedStock: number;
  SafetyStock: number;
  ReorderPoint: number;
  InProductionQty: number;
  BaseUnit: string;
}

// [sku, Lisbon stock, Lisbon safety, Porto stock, Porto safety, in production]
const STOCK: [string, number, number, number, number, number][] = [
  ['LC-MUG-SAGE', 48, 20, 12, 10, 24],
  ['LC-VASE-TALL', 0, 6, 9, 4, 8],
  ['LC-PLNT-SPK', 2, 10, 1, 4, 12],
  ['LC-BWL-RAMEN', 22, 8, 10, 4, 0],
  ['LC-MUG-SPECK', 31, 12, 8, 6, 0],
  ['LC-CNDL-HLD', 40, 10, 15, 6, 0],
  ['LC-LAMP-LUM', 1, 4, 7, 2, 3],
  ['LC-BWL-NEST', 14, 5, 6, 3, 0],
  ['LC-VASE-BUD', 18, 6, 9, 3, 0],
  ['LC-CUP-ESP', 26, 8, 12, 4, 0],
  ['LC-PLNT-HNG', 9, 4, 5, 2, 0],
  ['LC-PLT-DIN', 16, 6, 8, 4, 0],
];

export function stockRows(): StockRow[] {
  const rows: StockRow[] = [];
  for (const [sku, lis, lisSafety, por, porSafety, inProd] of STOCK) {
    const name = PRODUCTS.find((p) => p.sku === sku)!.title;
    rows.push({
      Material: sku, MaterialName: name, Plant: '1000', PlantName: PLANTS['1000'], StorageLocation: 'FG01',
      UnrestrictedStock: lis, SafetyStock: lisSafety, ReorderPoint: lisSafety * 2, InProductionQty: inProd, BaseUnit: 'PC',
    });
    rows.push({
      Material: sku, MaterialName: name, Plant: '1100', PlantName: PLANTS['1100'], StorageLocation: 'WH01',
      UnrestrictedStock: por, SafetyStock: porSafety, ReorderPoint: porSafety * 2, InProductionQty: 0, BaseUnit: 'PC',
    });
  }
  return rows;
}

export function productRows(): Record<string, unknown>[] {
  return PRODUCTS.map((p) => ({
    Product: p.sku,
    ProductDescription: p.title,
    ProductType: 'FERT',
    ProductGroup: p.section.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 9),
    BaseUnit: 'PC',
    GrossWeight: p.sku.includes('LAMP') ? '2.400' : p.sku.includes('VASE-TALL') ? '1.800' : '0.650',
    WeightUnit: 'KG',
    StandardPrice: (p.price / 100 / 2.6).toFixed(2),
    Currency: 'EUR',
  }));
}

export function salesOrderRows(now: Date): Record<string, unknown>[] {
  const today = dayAnchor(now);
  const orders: [string, string, string, number, number, string][] = [
    ['4500019231', 'Casa Alma Concept Store', 'LC-MUG-SAGE', 36, 6, 'B'],
    ['4500019240', 'Nordhaus Interiors GmbH', 'LC-VASE-TALL', 12, 4, 'A'],
    ['4500019248', 'Maison Verte', 'LC-PLNT-SPK', 20, 3, 'A'],
    ['4500019255', 'Studio Oku', 'LC-BWL-RAMEN', 24, 2, 'C'],
    ['4500019262', 'The Slow Table', 'LC-PLT-DIN', 16, 1, 'A'],
  ];
  return orders.map(([so, customer, sku, qty, daysAgo, status]) => {
    const p = PRODUCTS.find((x) => x.sku === sku)!;
    return {
      SalesOrder: so,
      SalesOrderType: 'OR',
      SoldToParty: customer,
      CreationDate: `/Date(${today - daysAgo * DAY_MS})/`,
      Material: sku,
      RequestedQuantity: String(qty),
      RequestedQuantityUnit: 'PC',
      TotalNetAmount: ((p.price / 100) * qty * 0.55).toFixed(2),
      TransactionCurrency: 'EUR',
      OverallDeliveryStatus: status,
      Plant: '1000',
    };
  });
}

/** Services that answer. Path → metadata builder and entity sets. */
export const LIVE_SERVICES = {
  '/sap/opu/odata/sap/ZLC_STOCK_OVERVIEW_SRV': 'stock',
  '/sap/opu/odata/sap/API_PRODUCT_SRV': 'product',
  '/sap/opu/odata/sap/API_SALES_ORDER_SRV': 'salesorder',
} as const;

// [technical name, title]
const CATALOG: [string, string][] = [
  ['ZLC_STOCK_OVERVIEW_SRV', 'Lumen & Clay: stock overview by plant, with safety stock and reorder point'],
  ['API_PRODUCT_SRV', 'Product Master'],
  ['API_SALES_ORDER_SRV', 'Sales Order (A2X)'],
  ['API_MATERIAL_STOCK_SRV', 'Material Stock (A2X)'],
  ['API_BUSINESS_PARTNER', 'Business Partner (A2X)'],
  ['API_PURCHASEORDER_PROCESS_SRV', 'Purchase Order (A2X)'],
  ['API_BILLING_DOCUMENT_SRV', 'Billing Document (A2X)'],
  ['API_OUTBOUND_DELIVERY_SRV', 'Outbound Delivery (A2X)'],
  ['API_INBOUND_DELIVERY_SRV', 'Inbound Delivery (A2X)'],
  ['API_PRODUCTION_ORDER_2_SRV', 'Production Order (A2X)'],
  ['API_PLANNED_ORDERS', 'Planned Order (A2X)'],
  ['API_MATERIAL_DOCUMENT_SRV', 'Material Document (A2X)'],
  ['API_PHYSICAL_INVENTORY_DOC_SRV', 'Physical Inventory Document (A2X)'],
  ['API_WAREHOUSE_ORDER_TASK_2', 'Warehouse Order and Task'],
  ['API_SUPPLIERINVOICE_PROCESS_SRV', 'Supplier Invoice (A2X)'],
  ['API_JOURNALENTRYITEMBASIC_SRV', 'Journal Entry Item (A2X)'],
  ['API_GLACCOUNTINCHARTOFACCOUNTS_SRV', 'G/L Account (A2X)'],
  ['API_COSTCENTER_SRV', 'Cost Center (A2X)'],
  ['API_PROFITCENTER_SRV', 'Profit Center (A2X)'],
  ['API_COMPANYCODE_SRV', 'Company Code (A2X)'],
  ['API_PLANT_SRV', 'Plant (A2X)'],
  ['API_STORAGELOCATION_SRV', 'Storage Location (A2X)'],
  ['API_CUSTOMER_MATERIAL_SRV', 'Customer Material (A2X)'],
  ['API_SLSPRICINGCONDITIONRECORD_SRV', 'Sales Pricing Condition Record (A2X)'],
  ['API_SALES_QUOTATION_SRV', 'Sales Quotation (A2X)'],
  ['API_SALES_CONTRACT_SRV', 'Sales Contract (A2X)'],
  ['API_CUSTOMER_RETURN_SRV', 'Customer Return (A2X)'],
  ['API_CREDIT_MEMO_REQUEST_SRV', 'Credit Memo Request (A2X)'],
  ['API_BILL_OF_MATERIAL_SRV;v=0002', 'Bill of Material (A2X)'],
  ['API_ROUTING', 'Routing (A2X)'],
  ['API_WORK_CENTERS', 'Work Center (A2X)'],
  ['API_QUALITYINSPECTIONLOT_SRV', 'Quality Inspection Lot (A2X)'],
  ['API_MAINTNOTIFICATION', 'Maintenance Notification (A2X)'],
  ['API_MAINTENANCEORDER', 'Maintenance Order (A2X)'],
  ['API_EQUIPMENT', 'Equipment (A2X)'],
  ['API_FIXEDASSET_SRV', 'Fixed Asset (A2X)'],
  ['API_BANKDETAIL_SRV', 'Bank Detail (A2X)'],
  ['API_CURRENCY_SRV', 'Currency (A2X)'],
  ['API_EXCHANGE_RATES_SRV', 'Exchange Rates (A2X)'],
  ['API_COUNTRY_SRV', 'Country (A2X)'],
  ['API_UNITOFMEASURE_SRV', 'Unit of Measure (A2X)'],
  ['API_PRODUCT_AVAILY_INFO_BASIC', 'Product Availability Information'],
];

export function catalogRows(origin: string): Record<string, unknown>[] {
  return CATALOG.map(([name, title]) => {
    const clean = name.replace(/;v=\d+$/, '');
    return {
      ID: `${clean}_0001`,
      TechnicalServiceName: clean,
      TechnicalServiceVersion: 1,
      Title: title,
      Description: title,
      ServiceUrl: `${origin}/sap/opu/odata/sap/${name}/`,
    };
  });
}

const EDMX_HEAD = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" xmlns:sap="http://www.sap.com/Protocols/SAPData">
  <edmx:DataServices m:DataServiceVersion="2.0">`;
const EDMX_TAIL = `
  </edmx:DataServices>
</edmx:Edmx>`;

export function metadataXml(kind: 'stock' | 'product' | 'salesorder'): string {
  if (kind === 'stock') {
    return `${EDMX_HEAD}
    <Schema Namespace="ZLC_STOCK_OVERVIEW_SRV" xml:lang="en" sap:schema-version="1" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
      <EntityType Name="StockOverviewType" sap:label="Stock Overview" sap:content-version="1">
        <Key><PropertyRef Name="Material"/><PropertyRef Name="Plant"/></Key>
        <Property Name="Material" Type="Edm.String" Nullable="false" MaxLength="40" sap:label="Material" sap:text="MaterialName"/>
        <Property Name="MaterialName" Type="Edm.String" MaxLength="80" sap:label="Material Description"/>
        <Property Name="Plant" Type="Edm.String" Nullable="false" MaxLength="4" sap:label="Plant" sap:text="PlantName"/>
        <Property Name="PlantName" Type="Edm.String" MaxLength="30" sap:label="Plant Name"/>
        <Property Name="StorageLocation" Type="Edm.String" MaxLength="4" sap:label="Storage Location"/>
        <Property Name="UnrestrictedStock" Type="Edm.Decimal" Precision="13" Scale="3" sap:label="Unrestricted-Use Stock" sap:unit="BaseUnit"/>
        <Property Name="SafetyStock" Type="Edm.Decimal" Precision="13" Scale="3" sap:label="Safety Stock" sap:unit="BaseUnit"/>
        <Property Name="ReorderPoint" Type="Edm.Decimal" Precision="13" Scale="3" sap:label="Reorder Point" sap:unit="BaseUnit"/>
        <Property Name="InProductionQty" Type="Edm.Decimal" Precision="13" Scale="3" sap:label="Qty in Production (Kiln)" sap:unit="BaseUnit"/>
        <Property Name="BaseUnit" Type="Edm.String" MaxLength="3" sap:label="Base Unit of Measure" sap:semantics="unit-of-measure"/>
      </EntityType>
      <EntityContainer Name="ZLC_STOCK_OVERVIEW_SRV_Entities" m:IsDefaultEntityContainer="true" sap:supported-formats="atom json xlsx">
        <EntitySet Name="StockOverview" EntityType="ZLC_STOCK_OVERVIEW_SRV.StockOverviewType" sap:label="Stock Overview by Plant" sap:creatable="false" sap:updatable="false" sap:deletable="false" sap:content-version="1"/>
      </EntityContainer>
    </Schema>${EDMX_TAIL}`;
  }
  if (kind === 'product') {
    return `${EDMX_HEAD}
    <Schema Namespace="API_PRODUCT_SRV" xml:lang="en" sap:schema-version="1" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
      <EntityType Name="A_ProductType" sap:label="Product" sap:content-version="1">
        <Key><PropertyRef Name="Product"/></Key>
        <Property Name="Product" Type="Edm.String" Nullable="false" MaxLength="40" sap:label="Product" sap:text="ProductDescription"/>
        <Property Name="ProductDescription" Type="Edm.String" MaxLength="80" sap:label="Product Description"/>
        <Property Name="ProductType" Type="Edm.String" MaxLength="4" sap:label="Product Type"/>
        <Property Name="ProductGroup" Type="Edm.String" MaxLength="9" sap:label="Product Group"/>
        <Property Name="BaseUnit" Type="Edm.String" MaxLength="3" sap:label="Base Unit" sap:semantics="unit-of-measure"/>
        <Property Name="GrossWeight" Type="Edm.Decimal" Precision="13" Scale="3" sap:label="Gross Weight" sap:unit="WeightUnit"/>
        <Property Name="WeightUnit" Type="Edm.String" MaxLength="3" sap:label="Weight Unit" sap:semantics="unit-of-measure"/>
        <Property Name="StandardPrice" Type="Edm.Decimal" Precision="12" Scale="2" sap:label="Standard Price" sap:unit="Currency"/>
        <Property Name="Currency" Type="Edm.String" MaxLength="5" sap:label="Currency" sap:semantics="currency-code"/>
      </EntityType>
      <EntityContainer Name="API_PRODUCT_SRV_Entities" m:IsDefaultEntityContainer="true" sap:supported-formats="atom json xlsx">
        <EntitySet Name="A_Product" EntityType="API_PRODUCT_SRV.A_ProductType" sap:label="Product" sap:content-version="1"/>
      </EntityContainer>
    </Schema>${EDMX_TAIL}`;
  }
  return `${EDMX_HEAD}
    <Schema Namespace="API_SALES_ORDER_SRV" xml:lang="en" sap:schema-version="1" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
      <EntityType Name="A_SalesOrderType" sap:label="Sales Order" sap:content-version="1">
        <Key><PropertyRef Name="SalesOrder"/></Key>
        <Property Name="SalesOrder" Type="Edm.String" Nullable="false" MaxLength="10" sap:label="Sales Order"/>
        <Property Name="SalesOrderType" Type="Edm.String" MaxLength="4" sap:label="Sales Order Type"/>
        <Property Name="SoldToParty" Type="Edm.String" MaxLength="40" sap:label="Sold-to Party"/>
        <Property Name="CreationDate" Type="Edm.DateTime" Precision="0" sap:display-format="Date" sap:label="Created On"/>
        <Property Name="Material" Type="Edm.String" MaxLength="40" sap:label="Material"/>
        <Property Name="RequestedQuantity" Type="Edm.Decimal" Precision="15" Scale="3" sap:label="Requested Quantity" sap:unit="RequestedQuantityUnit"/>
        <Property Name="RequestedQuantityUnit" Type="Edm.String" MaxLength="3" sap:label="Unit" sap:semantics="unit-of-measure"/>
        <Property Name="TotalNetAmount" Type="Edm.Decimal" Precision="16" Scale="3" sap:label="Net Value" sap:unit="TransactionCurrency"/>
        <Property Name="TransactionCurrency" Type="Edm.String" MaxLength="5" sap:label="Currency" sap:semantics="currency-code"/>
        <Property Name="OverallDeliveryStatus" Type="Edm.String" MaxLength="1" sap:label="Delivery Status (A open, B partial, C complete)"/>
        <Property Name="Plant" Type="Edm.String" MaxLength="4" sap:label="Delivering Plant"/>
      </EntityType>
      <EntityContainer Name="API_SALES_ORDER_SRV_Entities" m:IsDefaultEntityContainer="true" sap:supported-formats="atom json xlsx">
        <EntitySet Name="A_SalesOrder" EntityType="API_SALES_ORDER_SRV.A_SalesOrderType" sap:label="Sales Order" sap:content-version="1"/>
      </EntityContainer>
    </Schema>${EDMX_TAIL}`;
}
