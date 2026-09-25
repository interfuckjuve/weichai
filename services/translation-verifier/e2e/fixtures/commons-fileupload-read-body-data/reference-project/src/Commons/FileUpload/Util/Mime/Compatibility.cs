// MIME namespace counterparts for Apache Commons FileUpload 1.5.
// SPDX-License-Identifier: Apache-2.0
namespace Apache.Commons.FileUpload.Util.Mime;

/// .NET 侧该类型为 MIME 命名空间转发编码头文本解码。
public static class MimeUtility
{
    public static string DecodeText(string value) => global::Apache.Commons.FileUpload.Util.MimeUtility.DecodeText(value);
}

/// .NET 侧该类型为 MIME 命名空间转发 Base64 解码。
public static class Base64Decoder
{
    public static byte[] Decode(string value) => global::Apache.Commons.FileUpload.Util.Base64Decoder.Decode(value);
}

/// .NET 侧该类型为 MIME 命名空间转发 Quoted-Printable 解码。
public static class QuotedPrintableDecoder
{
    public static byte[] Decode(string value) => global::Apache.Commons.FileUpload.Util.QuotedPrintableDecoder.Decode(value);
}

/// .NET 侧该类型MIME 命名空间下的解析异常兼容类型。
public sealed class ParseException : global::Apache.Commons.FileUpload.Util.ParseException
{
    public ParseException(string message) : base(message) { }
}
