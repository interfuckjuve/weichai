// Java 翻译产物(agent 完成,作为 E2E 的目标侧输入)。
// 对应 C# MimeUtility.DecodeText;行为镜像:null 无防护(NPE),非 MIME 文本原样返回。
package org.apache.commons.fileupload.util.mime;

public class MimeUtility {
    public static String decodeText(String value) {
        if (!value.startsWith("=?") || !value.endsWith("?=")) return value;
        String[] parts = value.substring(2, value.length() - 2).split("\\?", 3);
        if (parts.length != 3) return value;
        java.nio.charset.Charset charset = java.nio.charset.Charset.forName(parts[0]);
        return parts[1].equalsIgnoreCase("B")
            ? new String(java.util.Base64.getDecoder().decode(parts[2]), charset)
            : new String(QuotedPrintableDecoder.decode(parts[2].replace('_', ' ')), charset);
    }
}

class QuotedPrintableDecoder {
    static byte[] decode(String value) {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '=' && i + 2 < value.length()) {
                String hex = value.substring(i + 1, i + 3);
                try {
                    out.write(Integer.parseInt(hex, 16));
                    i += 2;
                    continue;
                } catch (NumberFormatException ignored) {
                    // 非十六进制:把 '=' 当普通字符输出
                }
            }
            out.write((byte) c);
        }
        return out.toByteArray();
    }
}
