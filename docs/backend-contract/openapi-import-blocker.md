# OpenAPI Import Blocker

No OpenAPI client generation has run in this repository. The upstream OpenAPI 3.1 document must be
corrected and validated before it is imported.

## Required upstream correction

Two descriptions contain unquoted commas, which YAML can parse as structure rather than prose:

- `InvoiceUploadRequest.items[].quantity.description`
- `RefundUploadRequest.refund_all.description`

Keep the existing upstream wording exactly, but represent each description as a quoted scalar or a
block scalar. For example:

```yaml
InvoiceUploadRequest:
  properties:
    items:
      items:
        properties:
          quantity:
            description: >-
              <preserve the existing comma-containing upstream description verbatim>

RefundUploadRequest:
  properties:
    refund_all:
      description: >-
        <preserve the existing comma-containing upstream description verbatim>
```

After the upstream edit, validate the document as OpenAPI 3.1 and inspect both property objects to
confirm the comma text did not create bogus sibling keys. Only then should this repository import
the spec and decide on generated types/client tooling.
