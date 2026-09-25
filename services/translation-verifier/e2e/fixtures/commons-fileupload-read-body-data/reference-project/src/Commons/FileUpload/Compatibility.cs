// Compatibility types corresponding to Apache Commons FileUpload 1.5.
// SPDX-License-Identifier: Apache-2.0
using Apache.Commons.FileUpload.Disk;

namespace Apache.Commons.FileUpload;

[Obsolete("Use DiskFileItem instead.")]
/// 旧接口仍可借由这个磁盘条目适配器继续工作。
public class DefaultFileItem : DiskFileItem
{
    public DefaultFileItem(string? fieldName, string? contentType, bool isFormField, string? fileName, int sizeThreshold, string? repository)
        : base(fieldName, contentType, isFormField, fileName, sizeThreshold, repository) { }
}

[Obsolete("Use DiskFileItemFactory instead.")]
/// 这是为旧调用方保留的磁盘条目工厂外观。
public class DefaultFileItemFactory : DiskFileItemFactory
{
    public DefaultFileItemFactory() { }
    public DefaultFileItemFactory(int sizeThreshold, string? repository) : base(sizeThreshold, repository) { }

    public override FileItem CreateItem(string? fieldName, string? contentType, bool isFormField, string? fileName)
    {
        var item = new DefaultFileItem(fieldName, contentType, isFormField, fileName, GetSizeThreshold(), GetRepository());
        item.SetDefaultCharset(GetDefaultCharset());
        return item;
    }
}

[Obsolete("Use FileUpload with DiskFileItemFactory instead.")]
/// 该适配器延续早期磁盘上传的配置方式。
public class DiskFileUpload : FileUpload
{
    public DiskFileUpload() : this(new DefaultFileItemFactory()) { }

    public DiskFileUpload(DefaultFileItemFactory factory) : base(factory) { }

    public int GetSizeThreshold() => ((DefaultFileItemFactory)GetFileItemFactory()!).GetSizeThreshold();
    public void SetSizeThreshold(int value) => ((DefaultFileItemFactory)GetFileItemFactory()!).SetSizeThreshold(value);
    public string? GetRepositoryPath() => ((DefaultFileItemFactory)GetFileItemFactory()!).GetRepository();
    public void SetRepositoryPath(string value) => ((DefaultFileItemFactory)GetFileItemFactory()!).SetRepository(value);
}

/// 该接口支持逐项读取 multipart 内容，无须提前缓存整个请求。
public interface FileItemStream : FileItemHeadersSupport
{
    Stream OpenStream();
    string? GetContentType();
    string? GetFieldName();
    string? GetName();
    bool IsFormField();
}

/// 它定义了按请求顺序拉取流式条目的迭代协议。
public interface FileItemIterator
{
    bool HasNext();
    FileItemStream Next();
}

/// .NET 侧该类型把已物化的 FileItem 列表适配为流式条目迭代器。
public sealed class MaterializedFileItemIterator : FileItemIterator
{
    private readonly IEnumerator<FileItem> items;
    private FileItem? next;
    private bool checkedNext;

    public MaterializedFileItemIterator(IEnumerable<FileItem> items)
    {
        this.items = items.GetEnumerator();
    }

    public bool HasNext()
    {
        if (checkedNext) return next is not null;
        checkedNext = true;
        if (!items.MoveNext()) return false;
        next = items.Current;
        return true;
    }

    public FileItemStream Next()
    {
        if (!HasNext()) throw new InvalidOperationException("No more file items are available.");
        var item = next!;
        next = null;
        checkedNext = false;
        return new Item(item);
    }

    /// .NET 侧该类型把已物化 FileItem 包装为可流式读取的单个条目。
    private sealed class Item : FileItemStream
    {
        private readonly FileItem item;
        public Item(FileItem item) => this.item = item;
        public Stream OpenStream() => item.GetInputStream();
        public string? GetContentType() => item.GetContentType();
        public string? GetFieldName() => item.GetFieldName();
        public string? GetName() => item.GetName();
        public bool IsFormField() => item.IsFormField();
        public FileItemHeaders? GetHeaders() => item.GetHeaders();
        public void SetHeaders(FileItemHeaders? headers) => item.SetHeaders(headers);
    }
}
