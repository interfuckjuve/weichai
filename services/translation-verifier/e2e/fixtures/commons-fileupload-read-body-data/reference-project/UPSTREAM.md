# Upstream Mapping

The Java reference is Apache Commons FileUpload 1.5, released under the Apache
License 2.0. The Java skeleton retains the upstream package and test layout.
This C# reference maps the portable core classes one-to-one:

| Java class | C# class |
| --- | --- |
| `FileItem` | `FileItem` |
| `FileItemFactory` | `FileItemFactory` |
| `FileItemHeaders` | `FileItemHeaders` |
| `FileItemHeadersImpl` | `FileItemHeadersImpl` |
| `ParameterParser` | `ParameterParser` |
| `MultipartStream` | `MultipartStream` |
| `FileUploadBase` | `FileUploadBase` |
| `FileUpload` | `FileUpload` |
| `DiskFileItem` | `DiskFileItem` |
| `DiskFileItemFactory` | `DiskFileItemFactory` |

Source release: https://archive.apache.org/dist/commons/fileupload/source/commons-fileupload-1.5-src.tar.gz
