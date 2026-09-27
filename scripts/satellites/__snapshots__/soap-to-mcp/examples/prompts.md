# Example prompts: SOAP

Against the demo inventory service in this repository:

- Which articles are at or below their reorder level?
- Which articles in the Basel warehouse need reordering?
- How many DR-1001 steel doors do we have, and what do they cost?
- What is the status of order SO-24044, and when did we promise it?
- Which low-stock articles would cost the most to reorder up to twice their reorder level?
- Is order SO-24031 going to be late if production takes another two weeks?

Against your own SOAP services, the same pattern holds: ask the business question, and the model picks the operation.

- Which customers in our CRM (SOAP) have a credit limit above 50,000 EUR?
- Look up the tracking status of shipment 00340434161094022115 in our carrier's SOAP API.
- What does the ERP's GetPrice operation return for customer 10023 and article 4711?
- Validate this VAT ID with the EU VIES SOAP service: DE811569869.
