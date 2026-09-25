// Portlet-shaped adapters keep the FileUpload 1.5 surface portable to .NET.
// SPDX-License-Identifier: Apache-2.0
using Apache.Commons.FileUpload.Disk;

namespace Apache.Commons.FileUpload.Portlet;

/// 它把 Portlet 的正文和请求信息桥接到公共解析流程。
public interface PortletRequest
{
    string? CharacterEncoding { get; }
    string? ContentType { get; }
    long ContentLength { get; }
    Stream OpenBody();
}

/// PortletRequest 会在这里被转换为统一的上传视图。
public class PortletRequestContext : UploadContext
{
    private readonly PortletRequest request;
    public PortletRequestContext(PortletRequest request) => this.request = request;
    public string? GetCharacterEncoding() => request.CharacterEncoding;
    public string? GetContentType() => request.ContentType;
    public int GetContentLength() => request.ContentLength > int.MaxValue ? -1 : (int)request.ContentLength;
    public long ContentLength() => request.ContentLength;
    public Stream GetInputStream() => request.OpenBody();
}

/// 这是供 Portlet 宿主调用的 multipart 上传门面。
public class PortletFileUpload : FileUpload
{
    public PortletFileUpload() : this(new DiskFileItemFactory()) { }
    public PortletFileUpload(FileItemFactory factory) : base(factory) { }
    public static bool IsMultipartContent(PortletRequest request) => request.ContentType?.StartsWith(FileUploadBase.MULTIPART, StringComparison.OrdinalIgnoreCase) == true;
    public IReadOnlyList<FileItem> ParseRequest(PortletRequest request) => ParseRequest(new PortletRequestContext(request));
}
