// Agent-curated source input for E2E (完整方法体,agent 整理)。
// 提取自 fixtures/code-corpus/commons-fileupload-csharp/src/Commons/FileUpload/Util/Utilities.cs
// 的 MimeUtility.DecodeText(含其依赖的 QuotedPrintableDecoder),去掉 namespace 以便验证器
// C# 驱动(默认命名空间)直接引用;补充 using System.IO(System.IO.MemoryStream)。
using System;
using System.IO;
using System.Text;

public static class MimeUtility
{
    public static string DecodeText(string value)
    {
        if (!value.StartsWith("=?", StringComparison.Ordinal) || !value.EndsWith("?=", StringComparison.Ordinal)) return value;
        var parts = value[2..^2].Split('?', 3);
        if (parts.Length != 3) return value;
        var charset = Encoding.GetEncoding(parts[0]);
        return parts[1].Equals("B", StringComparison.OrdinalIgnoreCase)
            ? charset.GetString(Convert.FromBase64String(parts[2]))
            : charset.GetString(QuotedPrintableDecoder.Decode(parts[2].Replace('_', ' ')));
    }
}

public static class QuotedPrintableDecoder
{
    public static byte[] Decode(string value)
    {
        using var output = new MemoryStream();
        for (var index = 0; index < value.Length; index++)
        {
            if (value[index] == '=' && index + 2 < value.Length && byte.TryParse(value.Substring(index + 1, 2), System.Globalization.NumberStyles.HexNumber, null, out var decoded))
            {
                output.WriteByte(decoded);
                index += 2;
            }
            else
            {
                output.WriteByte((byte)value[index]);
            }
        }
        return output.ToArray();
    }
}
