# Commons FileUpload C# Reference

This is a C# 8/.NET 8 implementation of the Apache Commons FileUpload 1.5
core API. The class names and responsibilities intentionally correspond to the
Java source used by `commons-fileupload-java-skeleton`:

- `FileItem`, `FileItemFactory`, `FileItemHeaders`, `RequestContext`, and
  upload exceptions retain the same roles and observable contracts.
- `DiskFileItem` and `DiskFileItemFactory` preserve the configurable
  memory-to-temporary-file threshold, character-set lookup, explicit cleanup,
  and one-time disk move behavior.
- `ParameterParser`, `MultipartStream`, and `FileUploadBase` preserve header
  parameter parsing, boundary-delimited part parsing, source order, part
  metadata, and request/item/file-size limits.

The implementation is dependency-free and uses .NET streams and temporary
files in place of Commons IO and Java Servlet types. `tests/Program.cs`
exercises parameter quoting, threshold spilling, multipart field/file parsing,
and limits.

```text
dotnet run --project Commons.FileUpload.csproj
```

The behavior was derived from Apache Commons FileUpload 1.5. See `LICENSE`,
`NOTICE`, and `UPSTREAM.md` for the upstream license and source record.
