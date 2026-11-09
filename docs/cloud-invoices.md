# Invoices on AnythingMCP Cloud

This page is about the invoices for your AnythingMCP Cloud subscription. It does
not apply to self-hosted installations: self-hosted licences are managed on
anythingmcp.com/account.

## Where to find your invoices

Open **Settings → License** and select **Manage subscription & billing**. The
billing portal lists every invoice of the workspace, each with a PDF download.
You can update your company name, address and VAT ID there too; changes apply
to the next invoice.

Only workspace admins see this page.

## Invoices by email

On **Settings → License**, switch on **Invoices by email** to get every paid
invoice as a PDF attachment. It is off until an admin switches it on.

- **When:** right after each payment that has an amount. The €0 invoice that
  opens a card trial is not sent.
- **To whom:** the billing contact (the email address of the subscription in
  the billing portal), or another address you enter, for example your
  accounting team.
- **Changing the address:** the new address applies to the next invoice. The
  previous address gets a short notice saying invoices now go elsewhere.
- **What the email contains:** the invoice number, amount, period and the PDF.
  The link in the email opens Settings → License, which needs a sign-in.

Each invoice goes only to the address set for the workspace it belongs to.
When a licence key moves to another workspace, invoices by email are off for it
until an admin of the new workspace switches them on.

## From the command line

With a management key of a workspace admin (`amcp login --browser --scope admin`):

```bash
amcp invoices email                                   # show the setting
amcp invoices email on --yes                          # to the billing contact
amcp invoices email on --to accounting@example.com --yes
amcp invoices email --billing-contact --yes           # back to the billing contact
amcp invoices email off --yes
```

The same through the API: `GET /api/license/invoice-email` and
`PUT /api/license/invoice-email` with `{"enabled": true, "to": "accounting@example.com"}`
(`"to": null` for the billing contact; leave `to` out to keep the current address).
Both need an admin; a read-only management key can only read.
