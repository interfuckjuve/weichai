// Derived behaviorally from Apache Commons FileUpload 1.5.
// SPDX-License-Identifier: Apache-2.0
using System.Text;

namespace Apache.Commons.FileUpload.Disk;

/// 该条目先缓存小文件，达到阈值后再转存临时目录。
public class DiskFileItem : FileItem, FileItemHeadersSupport
{
    public const string DEFAULT_CHARSET = "ISO-8859-1";

    private readonly string? contentType;
    private readonly string? fileName;
    private readonly int sizeThreshold;
    private readonly string repository;
    private readonly SpillOutputStream storage;
    private byte[]? cachedContent;
    private long movedSize = -1;
    private string? fieldName;
    private bool isFormField;
    private string defaultCharset = DEFAULT_CHARSET;
    private FileItemHeaders? headers;

    static DiskFileItem()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    }

    public DiskFileItem(string? fieldName, string? contentType, bool isFormField, string? fileName, int sizeThreshold, string? repository)
    {
        this.fieldName = fieldName;
        this.contentType = contentType;
        this.isFormField = isFormField;
        this.fileName = fileName;
        this.sizeThreshold = sizeThreshold;
        this.repository = repository ?? Path.GetTempPath();
        storage = new SpillOutputStream(sizeThreshold, this.repository);
    }

    public Stream GetInputStream()
    {
        if (!IsInMemory())
        {
            return new FileStream(storage.FilePath!, FileMode.Open, FileAccess.Read, FileShare.Read);
        }
        cachedContent ??= storage.GetMemoryBytes();
        return new MemoryStream(cachedContent, writable: false);
    }

    public string? GetContentType() => contentType;

    public string? GetCharSet()
    {
        var parser = new ParameterParser();
        parser.SetLowerCaseNames(true);
        return parser.Parse(contentType, ';').GetValueOrDefault("charset");
    }

    public string? GetName() => Streams.CheckFileName(fileName);

    public bool IsInMemory() => cachedContent is not null || storage.IsInMemory;

    public long GetSize() => movedSize >= 0 ? movedSize : storage.Length;

    public byte[]? Get()
    {
        if (IsInMemory())
        {
            cachedContent ??= storage.GetMemoryBytes();
            return cachedContent;
        }
        try
        {
            return File.ReadAllBytes(storage.FilePath!);
        }
        catch (IOException)
        {
            return null;
        }
    }

    public string GetString(string charset) => Encoding.GetEncoding(charset).GetString(Get() ?? Array.Empty<byte>());

    public string GetString()
    {
        var charset = GetCharSet() ?? defaultCharset;
        try
        {
            return GetString(charset);
        }
        catch (ArgumentException)
        {
            return Encoding.Default.GetString(Get() ?? Array.Empty<byte>());
        }
    }

    public void Write(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        if (IsInMemory())
        {
            File.WriteAllBytes(path, Get() ?? Array.Empty<byte>());
            return;
        }
        storage.Flush();
        var source = storage.FilePath ?? throw new FileUploadException("Cannot write uploaded file to disk!");
        movedSize = new FileInfo(source).Length;
        File.Move(source, path, overwrite: true);
    }

    public void Delete()
    {
        cachedContent = null;
        storage.DeleteTemporaryFile();
    }

    public string? GetFieldName() => fieldName;
    public void SetFieldName(string? value) => fieldName = value;
    public bool IsFormField() => isFormField;
    public void SetFormField(bool value) => isFormField = value;
    public Stream GetOutputStream() => storage;
    public string? GetStoreLocation() => IsInMemory() ? null : storage.FilePath;
    public FileItemHeaders? GetHeaders() => headers;
    public void SetHeaders(FileItemHeaders? value) => headers = value;
    public void SetDefaultCharset(string value) => defaultCharset = value;
    public string GetDefaultCharset() => defaultCharset;

    /// .NET 侧该类型在内存阈值被超过时切换到临时文件的写入流。
    private sealed class SpillOutputStream : Stream
    {
        private readonly int threshold;
        private readonly string repository;
        private readonly MemoryStream memory = new();
        private FileStream? file;
        private string? filePath;
        private bool spilled;

        public SpillOutputStream(int threshold, string repository)
        {
            this.threshold = threshold;
            this.repository = repository;
        }

        public bool IsInMemory => !spilled;
        public string? FilePath => filePath;
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => file?.Length ?? (spilled && filePath is not null && File.Exists(filePath)
            ? new FileInfo(filePath).Length
            : memory.Length);
        public override long Position { get => Length; set => throw new NotSupportedException(); }

        public override void Flush() => file?.Flush();

        public override void Write(byte[] buffer, int offset, int count)
        {
            EnsureStorage(count);
            if (file is null)
            {
                memory.Write(buffer, offset, count);
            }
            else
            {
                file.Write(buffer, offset, count);
            }
        }

        public byte[] GetMemoryBytes() => memory.ToArray();

        public void DeleteTemporaryFile()
        {
            file?.Dispose();
            file = null;
            if (filePath is not null && File.Exists(filePath))
            {
                File.Delete(filePath);
            }
            if (!spilled)
            {
                memory.SetLength(0);
            }
        }

        private void EnsureStorage(int nextWrite)
        {
            if (file is not null || memory.Length + nextWrite <= threshold)
            {
                return;
            }
            Directory.CreateDirectory(repository);
            filePath = Path.Combine(repository, $"upload_{Guid.NewGuid():N}.tmp");
            file = new FileStream(filePath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
            memory.Position = 0;
            memory.CopyTo(file);
            memory.SetLength(0);
            spilled = true;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                file?.Dispose();
                file = null;
                // 关闭条目输出流只结束写入；内存内容仍须支持 get/getSize。
            }
            base.Dispose(disposing);
        }

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }
}

/// 工厂复用存储阈值、临时目录和编码设置来生成磁盘条目。
public class DiskFileItemFactory : FileItemFactory
{
    public const int DEFAULT_SIZE_THRESHOLD = 10240;
    private string? repository;
    private int sizeThreshold = DEFAULT_SIZE_THRESHOLD;
    private string defaultCharset = DiskFileItem.DEFAULT_CHARSET;

    public DiskFileItemFactory() { }

    public DiskFileItemFactory(int sizeThreshold, string? repository)
    {
        this.sizeThreshold = sizeThreshold;
        this.repository = repository;
    }

    public string? GetRepository() => repository;
    public void SetRepository(string? value) => repository = value;
    public int GetSizeThreshold() => sizeThreshold;
    public void SetSizeThreshold(int value) => sizeThreshold = value;
    public string GetDefaultCharset() => defaultCharset;
    public void SetDefaultCharset(string value) => defaultCharset = value;

    public virtual FileItem CreateItem(string? fieldName, string? contentType, bool isFormField, string? fileName)
    {
        var item = new DiskFileItem(fieldName, contentType, isFormField, fileName, sizeThreshold, repository);
        item.SetDefaultCharset(defaultCharset);
        return item;
    }
}
