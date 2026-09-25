// Servlet-shaped adapters keep the FileUpload 1.5 surface portable to .NET.
// SPDX-License-Identifier: Apache-2.0
using Apache.Commons.FileUpload.Disk;

namespace Apache.Commons.FileUpload.Servlet;

/// 它提取 Servlet 请求属性，使核心解析器无需依赖容器。
public interface ServletRequest
{
    string? CharacterEncoding { get; }
    string? ContentType { get; }
    long ContentLength { get; }
    Stream OpenBody();
}

/// ServletRequest 会在这里被转换为统一的上传视图。
public class ServletRequestContext : UploadContext
{
    private readonly ServletRequest request;
    public ServletRequestContext(ServletRequest request) => this.request = request;
    public string? GetCharacterEncoding() => request.CharacterEncoding;
    public string? GetContentType() => request.ContentType;
    public int GetContentLength() => request.ContentLength > int.MaxValue ? -1 : (int)request.ContentLength;
    public long ContentLength() => request.ContentLength;
    public Stream GetInputStream() => request.OpenBody();
}

/// 这是供 Servlet 宿主直接使用的 multipart 解析门面。
public class ServletFileUpload : FileUpload
{
    public ServletFileUpload() : this(new DiskFileItemFactory()) { }
    public ServletFileUpload(FileItemFactory factory) : base(factory) { }
    public static bool IsMultipartContent(ServletRequest request) => request.ContentType?.StartsWith(FileUploadBase.MULTIPART, StringComparison.OrdinalIgnoreCase) == true;
    public IReadOnlyList<FileItem> ParseRequest(ServletRequest request) => ParseRequest(new ServletRequestContext(request));
}

/// Web 生命周期结束时，它负责删除被跟踪条目的临时内容。
public sealed class FileCleanerCleanup
{
    private readonly List<WeakReference<FileItem>> tracked = new();
    public void Track(FileItem item) => tracked.Add(new WeakReference<FileItem>(item));
    public void ContextDestroyed()
    {
        foreach (var reference in tracked)
        {
            if (reference.TryGetTarget(out var item)) item.Delete();
        }
        tracked.Clear();
    }
}
