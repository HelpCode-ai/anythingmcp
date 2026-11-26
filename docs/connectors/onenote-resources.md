# Reading OneNote images and attachments

The OneNote connector can fetch images and attached files that appear as
authenticated Microsoft Graph links in a page's HTML. It uses the account
that authorized the connector on both AnythingMCP Cloud and self-hosted
installations. The existing delegated `Notes.ReadWrite` permission covers
the resource download; a read-only setup can use `Notes.Read`.

## Read an image from a page

1. Use `microsoft_onenote_get_page_content` to read the page HTML.
2. Find the image's `/resources/{id}/` link. Prefer `data-fullres-src` when
   present to retrieve the original image rather than its preview.
3. Call `microsoft_onenote_get_resource` with only that `resource_id`:

   ```json
   { "resource_id": "0-resource-id-from-the-page" }
   ```

Do not pass the complete resource URL, its `/content` or `/$value` suffix,
or an access token as an argument. The connector adds its existing sign-in
and requests the documented Graph endpoint
`/me/onenote/resources/{resource_id}/content`.

PNG, JPEG, GIF and WebP downloads are returned as MCP image content for
clients that support images. Other binary files, such as PDF attachments,
are returned as embedded resources. The client must support that content
type to make use of the attachment; the tool does not extract a PDF's text.

## Limits

- The attachment limit is 4 MiB. Larger files are described without embedding
  their bytes; the instance's HTTP response-size limit also applies.
- A resource must be accessible to the Microsoft account that authorized
  the connector. This tool does not make a private Graph link public.
- Resources already present in a page can be downloaded. Uploading new
  attachments is outside this tool's scope.
- Handwritten ink strokes are not rendered by this tool. An existing image
  of a printout can be read, but the tool does not render an entire page or
  combine its text, images and ink.

See the [Graph resource API](https://learn.microsoft.com/en-us/graph/api/resource-get?view=graph-rest-1.0)
and [OneNote content guide](https://learn.microsoft.com/en-us/graph/onenote-get-content)
for the resource paths and delegated permissions.
