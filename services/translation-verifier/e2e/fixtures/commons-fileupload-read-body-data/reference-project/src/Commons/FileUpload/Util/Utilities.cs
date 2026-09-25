// Utility counterparts for Apache Commons FileUpload 1.5.
// SPDX-License-Identifier: Apache-2.0
using System.Text;
using System.Text.RegularExpressions;

namespace Apache.Commons.FileUpload.Util;

/// .NET 侧该门面转发 commons-fileupload util 包中的流复制和名称检查能力。
public static class Streams
{
    public const int DEFAULT_BUFFER_SIZE = global::Apache.Commons.FileUpload.Streams.DEFAULT_BUFFER_SIZE;

    public static long Copy(Stream input, Stream? output, bool closeOutputStream, byte[]? buffer = null)
        => global::Apache.Commons.FileUpload.Streams.Copy(input, output, closeOutputStream, buffer);

    public static string CheckFileName(string? fileName)
        => global::Apache.Commons.FileUpload.Streams.CheckFileName(fileName);
}

/// 资源实现此约定后可以向调用方报告是否已经关闭。
public interface Closeable
{
    bool IsClosed();
}

/// 读取包装器会累计字节数，并在未知长度的请求超额时中止。
public abstract class LimitedInputStream : Stream, Closeable
{
    private readonly Stream input;
    private readonly long sizeMax;
    private long count;
    private bool closed;

    protected LimitedInputStream(Stream input, long sizeMax)
    {
        this.input = input;
        this.sizeMax = sizeMax;
    }

    protected abstract void RaiseError(long sizeMax, long count);
    public bool IsClosed() => closed;
    public long GetCount() => count;

    public override int Read(byte[] buffer, int offset, int length)
    {
        var read = input.Read(buffer, offset, length);
        if (read > 0)
        {
            count += read;
            if (count > sizeMax) RaiseError(sizeMax, count);
        }
        return read;
    }

    public override bool CanRead => input.CanRead;
    public override bool CanSeek => input.CanSeek;
    public override bool CanWrite => false;
    public override long Length => input.Length;
    public override long Position { get => input.Position; set => input.Position = value; }
    public override void Flush() => input.Flush();
    public override long Seek(long offset, SeekOrigin origin) => input.Seek(offset, origin);
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            input.Dispose();
            closed = true;
        }
        base.Dispose(disposing);
    }
}

/// 该帮助类负责还原 RFC 2047 格式的邮件头文本。
public static class MimeUtility
{
    private static readonly Regex EncodedWord = new(@"=\?([^?]+)\?([bBqQ])\?([^?]*)\?=", RegexOptions.Compiled);

    static MimeUtility()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    }

    public static string DecodeText(string value)
    {
        if (!value.Contains("=?", StringComparison.Ordinal)) return value;
        var compact = Regex.Replace(value, @"\?=\s+=\?", "?==?");
        return EncodedWord.Replace(compact, match =>
        {
            var charset = Encoding.GetEncoding(match.Groups[1].Value);
            var payload = match.Groups[2].Value.Equals("B", StringComparison.OrdinalIgnoreCase)
                ? Base64Decoder.Decode(match.Groups[3].Value)
                : QuotedPrintableDecoder.Decode(match.Groups[3].Value.Replace('_', ' '));
            return charset.GetString(payload);
        });
    }
}

/// 该解码器处理 MIME 头里的 Base64 载荷。
public static class Base64Decoder
{
    public static byte[] Decode(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        using var output = new MemoryStream();
        var quartet = new StringBuilder(4);
        foreach (var character in value)
        {
            if (!IsBase64Character(character)) continue;
            quartet.Append(character);
            if (quartet.Length != 4) continue;
            var block = quartet.ToString();
            ValidatePadding(block);
            var decoded = Convert.FromBase64String(block);
            output.Write(decoded, 0, decoded.Length);
            quartet.Clear();
        }
        if (quartet.Length != 0)
        {
            throw new InvalidDataException("truncated Base64 input");
        }
        return output.ToArray();
    }

    private static bool IsBase64Character(char character)
        => character is >= 'A' and <= 'Z'
            or >= 'a' and <= 'z'
            or >= '0' and <= '9'
            or '+' or '/' or '=';

    private static void ValidatePadding(string block)
    {
        var padding = block.IndexOf('=');
        if (padding < 0) return;
        if (padding < 2 || block.Skip(padding).Any(character => character != '='))
        {
            throw new InvalidDataException("incorrect Base64 padding");
        }
    }
}

/// 该解码器将 Quoted-Printable 头值还原为字节。
public static class QuotedPrintableDecoder
{
    public static byte[] Decode(string value)
    {
        using var output = new MemoryStream();
        for (var index = 0; index < value.Length; index++)
        {
            if (value[index] != '=')
            {
                output.WriteByte((byte)value[index]);
                continue;
            }
            if (index + 1 >= value.Length)
            {
                throw new InvalidDataException("truncated quoted-printable escape");
            }
            if (value[index + 1] == '\r')
            {
                if (index + 2 >= value.Length || value[index + 2] != '\n')
                {
                    throw new InvalidDataException("CR must be followed by LF");
                }
                index += 2;
                continue;
            }
            if (index + 2 >= value.Length || !byte.TryParse(value.Substring(index + 1, 2), System.Globalization.NumberStyles.HexNumber, null, out var decoded))
            {
                throw new InvalidDataException("invalid quoted-printable escape");
            }
            output.WriteByte(decoded);
            index += 2;
        }
        return output.ToArray();
    }
}

/// MIME 编码字段无法读取时会抛出这一异常。
public class ParseException : Exception
{
    public ParseException(string message) : base(message) { }
}
