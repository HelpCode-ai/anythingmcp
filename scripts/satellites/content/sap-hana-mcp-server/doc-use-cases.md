# Use cases

What people ask, and what the connector does to answer. The SQL comes from the `recipes` chapter of `sap_guide`; client `100`, company code `1010` and fiscal year 2025 stand in for yours. The model states the assumptions it made, such as the revenue account range, and asks you to confirm them.

## Revenue per posting period

> "What was our revenue per posting period in 2025?"

Tools: `sap_guide` → `sap_org_structure` → `sap_query`. Table: `ACDOCA` (Universal Journal), leading ledger `0L`, amounts in company code currency. Revenue is a credit, so the sum is negated.

```sql
SELECT POPER, RHCUR AS CURRENCY, -SUM(HSL) AS REVENUE
FROM ACDOCA
WHERE RCLNT = '100' AND RLDNR = '0L' AND RBUKRS = '1010' AND GJAHR = '2025'
  AND RACCT BETWEEN '0040000000' AND '0049999999'  -- revenue accounts: confirm the range
GROUP BY POPER, RHCUR ORDER BY POPER;
```

## Overdue receivables

> "Which customers have invoices more than 60 days overdue, and how much?"

Open customer items at a key date (`KOART = 'D'`, not cleared by then), aged by net due date `NETDT`. Period `000` holds carried-forward balances and is left out.

```sql
SELECT KUNNR, RHCUR AS CURRENCY,
       SUM(HSL) AS OPEN_AMOUNT,
       SUM(CASE WHEN NETDT >= '20251231' THEN HSL ELSE 0 END) AS NOT_DUE,
       SUM(CASE WHEN NETDT < '20251231' AND NETDT >= '20251101' THEN HSL ELSE 0 END) AS OVERDUE_1_60,
       SUM(CASE WHEN NETDT < '20251101' THEN HSL ELSE 0 END) AS OVERDUE_OVER_60
FROM ACDOCA
WHERE RCLNT = '100' AND RLDNR = '0L' AND RBUKRS = '1010' AND KOART = 'D' AND POPER <> '000'
  AND BUDAT <= '20251231' AND (AUGDT = '00000000' OR AUGDT > '20251231')
GROUP BY KUNNR, RHCUR ORDER BY OVERDUE_OVER_60 DESC LIMIT 20;
```

## Top customers

> "Who were our top 10 customers by net sales in 2025?"

From billing documents, not from the journal: in `ACDOCA` the customer sits on the receivable line, not on the revenue line. The model reads the values of `VBRK.VBTYP` first (`sap_field_values`) to tell invoices from credit memos and cancellations.

```sql
SELECT k.KUNAG, c.NAME1, k.WAERK, SUM(p.NETWR) AS NET_SALES
FROM VBRK k JOIN VBRP p ON p.MANDT = k.MANDT AND p.VBELN = k.VBELN
LEFT JOIN KNA1 c ON c.MANDT = k.MANDT AND c.KUNNR = k.KUNAG
WHERE k.MANDT = '100' AND k.FKDAT BETWEEN '20250101' AND '20251231'
  AND k.FKSTO = '' AND k.VBTYP = 'M'
GROUP BY k.KUNAG, c.NAME1, k.WAERK ORDER BY NET_SALES DESC LIMIT 10;
```

## More questions by area

- **Finance:** DSO for the quarter (open receivables over revenue of the same days, corrected for VAT), P&L accounts per period, balance of inventory accounts at period end.
- **Sales:** net sales per month from billing, open sales orders per customer, rejected order items.
- **Procurement:** purchase orders past their delivery date, per supplier.
- **Inventory:** goods movements per movement type and plant (`MATDOC`), materials with stock and no movement.
- **Master data:** customers without a VAT number, duplicate names in the customer master.
- **The system itself:** which company codes, plants and sales organizations exist; which CDS views are released and analytical for a topic.

The step-by-step setup with screenshots: [Connect SAP S/4HANA to Claude via SAP HANA](https://anythingmcp.com/guides/connect-sap-hana-to-claude).
