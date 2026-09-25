// Derived behaviorally from Apache Commons FileUpload 1.5.
// SPDX-License-Identifier: Apache-2.0
using System.Collections;
using System.Text;
using Apache.Commons.FileUpload.Util;

namespace Apache.Commons.FileUpload;

/// 该接口描述上传字段的内容访问、元数据和落盘能力。
public interface FileItem
{
    Stream GetInputStream();
    string? GetContentType();
    string? GetName();
    bool IsInMemory();
    long GetSize();
    byte[]? Get();
    string GetString(string charset);
    string GetString();
    void Write(string path);
    void Delete();
    string? GetFieldName();
    void SetFieldName(string? fieldName);
    bool IsFormField();
    void SetFormField(bool state);
    Stream GetOutputStream();
    FileItemHeaders? GetHeaders();
    void SetHeaders(FileItemHeaders? headers);
}

/// 该工厂根据表单元数据实例化对应的上传对象。
public interface FileItemFactory
{
    FileItem CreateItem(string? fieldName, string? contentType, bool isFormField, string? fileName);
}

/// 该集合按忽略大小写的方式维护可重复的 multipart 头值。
public interface FileItemHeaders
{
    string? GetHeader(string name);
    IEnumerator<string> GetHeaders(string name);
    IEnumerator<string> GetHeaderNames();
}

/// 该约定让上传对象携带并更新关联的 MIME 头。
public interface FileItemHeadersSupport
{
    FileItemHeaders? GetHeaders();
    void SetHeaders(FileItemHeaders? headers);
}

/// 它把宿主请求包装为解析器所需的元数据和正文来源。
public interface RequestContext
{
    string? GetCharacterEncoding();
    string? GetContentType();
    int GetContentLength();
    Stream GetInputStream();
}

/// 此上下文额外暴露不会截断的大请求长度。
public interface UploadContext : RequestContext
{
    long ContentLength();
}

/// 上传过程会通过这个委托报告字节数、总量和条目计数。
public delegate void ProgressListener(long bytesRead, long contentLength, int items);

/// 上传管线发生解析或存储问题时会使用此基础异常。
public class FileUploadException : Exception
{
    public FileUploadException() { }
    public FileUploadException(string message) : base(message) { }
    public FileUploadException(string message, Exception cause) : base(message, cause) { }
}

/// 附件个数越过配置阈值时由该异常报告。
public sealed class FileCountLimitExceededException : FileUploadException
{
    public FileCountLimitExceededException(string message, long limit) : base(message)
    {
        Limit = limit;
    }

    public long Limit { get; }
}

/// 文件名含有 NUL 等危险字符时会在此处被拒绝。
public sealed class InvalidFileNameException : ArgumentException
{
    public InvalidFileNameException(string? name, string message) : base(message)
    {
        Name = name;
    }

    public string? Name { get; }
}

/// .NET 侧该类型以大小写不敏感字典保存可重复的 multipart 请求头。
public class FileItemHeadersImpl : FileItemHeaders
{
    private readonly Dictionary<string, List<string>> headers = new(StringComparer.OrdinalIgnoreCase);

    public void AddHeader(string name, string value)
    {
        ArgumentNullException.ThrowIfNull(name);
        lock (headers)
        {
            if (!headers.TryGetValue(name, out var values))
            {
                values = new List<string>();
                headers[name] = values;
            }
            values.Add(value);
        }
    }

    public string? GetHeader(string name)
    {
        lock (headers)
        {
            return headers.TryGetValue(name, out var values) && values.Count > 0 ? values[0] : null;
        }
    }

    public IEnumerator<string> GetHeaders(string name)
    {
        lock (headers)
        {
            return (headers.TryGetValue(name, out var values) ? values.ToArray() : Array.Empty<string>()).AsEnumerable().GetEnumerator();
        }
    }

    public IEnumerator<string> GetHeaderNames()
    {
        lock (headers)
        {
            return headers.Keys.ToArray().AsEnumerable().GetEnumerator();
        }
    }
}

/// 它读取媒体头参数，并正确保留引号中的分隔符。
public sealed class ParameterParser
{
    public bool IsLowerCaseNames { get; private set; }

    public void SetLowerCaseNames(bool value) => IsLowerCaseNames = value;

    public Dictionary<string, string?> Parse(string? value, params char[] separators)
    {
        if (separators is null || separators.Length == 0)
        {
            return new Dictionary<string, string?>();
        }
        var separator = separators[0];
        if (value is not null)
        {
            var index = value.Length;
            foreach (var candidate in separators)
            {
                var found = value.IndexOf(candidate);
                if (found >= 0 && found < index)
                {
                    index = found;
                    separator = candidate;
                }
            }
        }
        return Parse(value, separator);
    }

    public Dictionary<string, string?> Parse(string? value, char separator)
    {
        var result = new Dictionary<string, string?>();
        if (value is null)
        {
            return result;
        }

        var position = 0;
        while (position < value.Length)
        {
            var name = ReadToken(value, ref position, '=', separator, quoted: false);
            string? parameterValue = null;
            if (position < value.Length && value[position] == '=')
            {
                position++;
                parameterValue = ReadToken(value, ref position, separator, quoted: true);
            }
            if (position < value.Length && value[position] == separator)
            {
                position++;
            }
            if (!string.IsNullOrEmpty(name))
            {
                result[IsLowerCaseNames ? name.ToLowerInvariant() : name] = parameterValue;
            }
        }
        return result;
    }

    private static string? ReadToken(string value, ref int position, char terminator, bool quoted)
        => ReadToken(value, ref position, new[] { terminator }, quoted);

    private static string? ReadToken(string value, ref int position, char first, char second, bool quoted)
        => ReadToken(value, ref position, new[] { first, second }, quoted);

    private static string? ReadToken(string value, ref int position, char[] terminators, bool quoted)
    {
        var start = position;
        var inQuotes = false;
        var escaped = false;
        while (position < value.Length)
        {
            var current = value[position];
            if ((!quoted || !inQuotes) && terminators.Contains(current))
            {
                break;
            }
            if (quoted && !escaped && current == '"')
            {
                inQuotes = !inQuotes;
            }
            escaped = !escaped && current == '\\';
            position++;
        }
        var token = value[start..position].Trim();
        if (token.Length >= 2 && token[0] == '"' && token[^1] == '"')
        {
            token = token[1..^1];
        }
        return token.Length == 0 ? null : MimeUtility.DecodeText(token);
    }
}

/// 这里集中放置流复制和安全文件名检查的辅助逻辑。
public static class Streams
{
    public const int DEFAULT_BUFFER_SIZE = 8192;

    public static long Copy(Stream input, Stream? output, bool closeOutputStream, byte[]? buffer = null)
    {
        buffer ??= new byte[DEFAULT_BUFFER_SIZE];
        long total = 0;
        try
        {
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                total += read;
                output?.Write(buffer, 0, read);
            }
            output?.Flush();
            return total;
        }
        finally
        {
            input.Dispose();
            if (closeOutputStream)
            {
                output?.Dispose();
            }
        }
    }

    public static string CheckFileName(string? fileName)
    {
        if (fileName is not null && fileName.Contains('\0'))
        {
            throw new InvalidFileNameException(fileName, $"Invalid file name: {fileName.Replace("\0", "\\0")}");
        }
        return fileName!;
    }
}
