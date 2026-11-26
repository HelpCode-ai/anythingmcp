# Reading shared OneNote notebooks

The OneNote connector has read tools for SharePoint site notebooks and
Microsoft 365 group notebooks. Use a work or school Microsoft account that
already has access to the site or group. Personal Microsoft accounts do not
have organizational sites or Microsoft 365 groups.

## Permissions and sign-in

The connector's default OAuth scopes remain `offline_access User.Read
Notes.ReadWrite`, for its existing personal-notebook tools. To read shared
notebooks, add the delegated `Notes.Read.All` permission to your Entra app
and the connector's OAuth scopes, then authorize with the provider again.
This scope covers notebooks the signed-in user can access; it does not grant
the user new membership or access to every notebook in the organization.

Delegated `Notes.Read.All` does not inherently require administrator consent,
but the organization's consent policy can require an administrator. An
existing delegated `Notes.ReadWrite.All` grant also covers reads; these new
tools make no writes. Application-only credentials are not used here.

## Choose the owner, then read pages

Use the same `site_id` or `group_id` throughout the sequence:

| Step | SharePoint site | Microsoft 365 group |
|---|---|---|
| Find notebooks | `microsoft_onenote_list_site_notebooks` | `microsoft_onenote_list_group_notebooks` |
| Find sections | `microsoft_onenote_list_site_sections` | `microsoft_onenote_list_group_sections` |
| List a section's pages | `microsoft_onenote_list_site_section_pages` | `microsoft_onenote_list_group_section_pages` |
| Read page metadata | `microsoft_onenote_get_site_page` | `microsoft_onenote_get_group_page` |
| Read page HTML | `microsoft_onenote_get_site_page_content` | `microsoft_onenote_get_group_page_content` |
| Download an image or file | `microsoft_onenote_get_site_resource` | `microsoft_onenote_get_group_resource` |

Get the owner ID from Microsoft Graph or an existing SharePoint/group
integration. A Graph site ID normally has the form
`hostname,site-collection-guid,web-guid`; a group ID is a GUID. Pass those
IDs, not browser URLs. These tools do not discover sites or groups.

Section results identify their parent notebook. List pages section by
section, following `@odata.nextLink` with the same filters and the next
`skip` value. Use `include_ids` when the page HTML needs element IDs.

For a page resource, copy only the ID from its `/resources/{id}/` link,
preferring `data-fullres-src` for an original image. Supported images become
MCP image content and other binary files become embedded resources. Files
above 4 MiB are described without their bytes; the instance response-size
limit also applies. Page HTML is capped at about 200 KB. Ink is not rendered for site and group
notebooks; page previews cover only the signed-in user's own notebooks.

Cloud and self-hosted use the same Graph endpoints, permissions and sign-in.
A Graph refusal fails the request; it does not fall back to another owner.

See Microsoft's [notebook API](https://learn.microsoft.com/en-us/graph/api/onenote-list-notebooks?view=graph-rest-1.0),
[resource API](https://learn.microsoft.com/en-us/graph/api/resource-get?view=graph-rest-1.0)
and [permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference#notesreadall).
