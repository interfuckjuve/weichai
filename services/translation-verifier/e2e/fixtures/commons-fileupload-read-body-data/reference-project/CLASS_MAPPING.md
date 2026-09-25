# Class Mapping

The Java skeleton retains the Apache Commons FileUpload 1.5 source tree. This
reference has a C# counterpart for every public production type that matters to
the upload API. Java packages map to the equivalent `Apache.Commons.FileUpload`
namespace and its `Disk`, `Servlet`, `Portlet`, and `Util` children.

| Java 1.5 type | C# counterpart |
| --- | --- |
| `FileItem`, `FileItemFactory`, `FileItemHeaders`, `FileItemHeadersSupport` | same name in `Apache.Commons.FileUpload` |
| `RequestContext`, `UploadContext`, `ProgressListener` | same name in `Apache.Commons.FileUpload` |
| `FileUpload`, `FileUploadBase`, `FileUploadException`, `FileCountLimitExceededException`, `InvalidFileNameException` | same name in `Apache.Commons.FileUpload` |
| `DefaultFileItem`, `DefaultFileItemFactory`, `DiskFileUpload` | same name in `Apache.Commons.FileUpload` |
| `FileItemIterator`, `FileItemStream` | same name, backed by `MaterializedFileItemIterator` |
| `MultipartStream` and nested helper/exception types | same name and nested types |
| `disk.DiskFileItem`, `disk.DiskFileItemFactory` | same name in `.Disk` |
| `servlet.ServletFileUpload`, `servlet.ServletRequestContext`, `servlet.FileCleanerCleanup` | same name in `.Servlet`, backed by a portable `ServletRequest` |
| `portlet.PortletFileUpload`, `portlet.PortletRequestContext` | same name in `.Portlet`, backed by a portable `PortletRequest` |
| `util.Closeable`, `util.FileItemHeadersImpl`, `util.LimitedInputStream`, `util.Streams` | same name in `.Util` |
| `util.mime.MimeUtility`, `Base64Decoder`, `QuotedPrintableDecoder`, `ParseException` | same name in `.Util.Mime` |

Servlet and Portlet integration points use small .NET-neutral request
interfaces rather than importing a Java container API. The multipart parsing,
limits, item storage, header semantics, and lifecycle behavior live in the
shared core classes and are exercised by the executable regression suite.
