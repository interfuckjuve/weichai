// Derived behaviorally from Apache Commons FileUpload 1.5.
// SPDX-License-Identifier: Apache-2.0
using System.Text;

namespace Apache.Commons.FileUpload;

/// 它从请求字节中定位分隔符，并逐段产出头部和内容。
public sealed class MultipartStream
{
    private readonly byte[] data;
    private byte[] boundary;
    private IReadOnlyList<MultipartPart>? parts;
    private int partIndex;

    public MultipartStream(Stream input, byte[] boundary)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(boundary);
        if (boundary.Length == 0)
        {
            throw new ArgumentException("Multipart boundary must not be empty.", nameof(boundary));
        }
        using var buffer = new MemoryStream();
        input.CopyTo(buffer);
        data = buffer.ToArray();
        this.boundary = boundary.ToArray();
    }

    public void SetBoundary(byte[] value)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (value.Length != boundary.Length)
        {
            throw new IllegalBoundaryException("The length of a boundary token cannot change within a multipart stream.");
        }
        boundary = value.ToArray();
        parts = null;
        partIndex = 0;
    }

    public bool SkipPreamble()
    {
        EnsureParts();
        return parts!.Count > 0;
    }

    public bool ReadBoundary()
    {
        EnsureParts();
        return partIndex < parts!.Count;
    }

    public string ReadHeaders()
    {
        EnsureParts();
        if (partIndex >= parts!.Count)
        {
            throw new MalformedStreamException("No multipart item is available.");
        }
        return parts[partIndex].RawHeaders;
    }

    public int ReadBodyData(Stream? output)
    {
        EnsureParts();
        if (partIndex >= parts!.Count)
        {
            throw new MalformedStreamException("No multipart item is available.");
        }
        var body = parts[partIndex++].Body;
        output?.Write(body, 0, body.Length);
        output?.Flush();
        return body.Length;
    }

    public int DiscardBodyData() => ReadBodyData(null);

    internal IReadOnlyList<MultipartPart> ReadParts()
    {
        EnsureParts();
        return parts!;
    }

    private void EnsureParts()
    {
        parts ??= ParseParts(data, boundary);
    }

    private static IReadOnlyList<MultipartPart> ParseParts(byte[] source, byte[] rawBoundary)
    {
        var marker = Encoding.ASCII.GetBytes("--" + Encoding.ASCII.GetString(rawBoundary));
        var delimiter = Encoding.ASCII.GetBytes("\r\n--" + Encoding.ASCII.GetString(rawBoundary));
        var parsed = new List<MultipartPart>();
        var cursor = Find(source, marker, 0);
        if (cursor < 0)
        {
            return parsed;
        }
        cursor += marker.Length;
        if (StartsWith(source, cursor, Encoding.ASCII.GetBytes("--")))
        {
            return parsed;
        }
        cursor = ConsumeLineBreak(source, cursor);
        while (cursor < source.Length)
        {
            var headerEnd = Find(source, new byte[] { 13, 10, 13, 10 }, cursor);
            if (headerEnd < 0)
            {
                throw new MalformedStreamException("Multipart headers were not terminated by an empty line.");
            }
            var headers = Encoding.Latin1.GetString(source, cursor, headerEnd - cursor);
            var bodyStart = headerEnd + 4;
            var boundaryAt = Find(source, delimiter, bodyStart);
            if (boundaryAt < 0)
            {
                throw new MalformedStreamException("Multipart body ended before its terminating boundary.");
            }
            var bodyLength = boundaryAt - bodyStart;
            var body = new byte[bodyLength];
            Buffer.BlockCopy(source, bodyStart, body, 0, bodyLength);
            parsed.Add(new MultipartPart(headers, body));
            cursor = boundaryAt + delimiter.Length;
            if (StartsWith(source, cursor, Encoding.ASCII.GetBytes("--")))
            {
                break;
            }
            cursor = ConsumeLineBreak(source, cursor);
        }
        return parsed;
    }

    private static int ConsumeLineBreak(byte[] source, int offset)
    {
        if (StartsWith(source, offset, new byte[] { 13, 10 })) return offset + 2;
        if (StartsWith(source, offset, new byte[] { 10 })) return offset + 1;
        throw new MalformedStreamException("Multipart boundary must be followed by a line break.");
    }

    private static bool StartsWith(byte[] source, int offset, byte[] needle)
    {
        if (offset < 0 || source.Length - offset < needle.Length) return false;
        for (var index = 0; index < needle.Length; index++)
        {
            if (source[offset + index] != needle[index]) return false;
        }
        return true;
    }

    private static int Find(byte[] source, byte[] needle, int start)
    {
        for (var offset = start; offset <= source.Length - needle.Length; offset++)
        {
            if (StartsWith(source, offset, needle)) return offset;
        }
        return -1;
    }

    /// .NET 侧该类型保存一个 multipart 分段的原始头文本和二进制正文。
    internal sealed record MultipartPart(string RawHeaders, byte[] Body);

    /// .NET 侧该类型累计已读字节与条目数量并通知上传进度监听器。
    public sealed class ProgressNotifier
    {
        private readonly ProgressListener? listener;
        private readonly long contentLength;
        private long bytesRead;
        private int items;

        public ProgressNotifier(ProgressListener? listener, long contentLength)
        {
            this.listener = listener;
            this.contentLength = contentLength;
        }

        public void NoteBytesRead(int count)
        {
            bytesRead += count;
            listener?.Invoke(bytesRead, contentLength, items);
        }

        public void NoteItem()
        {
            items++;
            listener?.Invoke(bytesRead, contentLength, items);
        }
    }

    /// .NET 侧该类型为单个 multipart 条目提供可关闭的只读输入流。
    public sealed class ItemInputStream : MemoryStream, Util.Closeable
    {
        private bool closed;

        public ItemInputStream(byte[] body) : base(body, writable: false) { }

        public bool IsClosed() => closed;

        protected override void Dispose(bool disposing)
        {
            closed = true;
            base.Dispose(disposing);
        }
    }

    /// 分段格式、头区或结束边界损坏时用它报告。
    public sealed class MalformedStreamException : IOException
    {
        public MalformedStreamException(string message) : base(message) { }
    }

    /// 边界长度在读取过程中改变会被视为非法配置。
    public sealed class IllegalBoundaryException : ArgumentException
    {
        public IllegalBoundaryException(string message) : base(message) { }
    }
}
