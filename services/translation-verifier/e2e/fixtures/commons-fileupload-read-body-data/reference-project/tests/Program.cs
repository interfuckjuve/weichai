using System.Text;
using Apache.Commons.FileUpload;
using Apache.Commons.FileUpload.Disk;
using Apache.Commons.FileUpload.Util;

static class Program
{
    private static int Main()
    {
        ParameterParsingPreservesQuotedValues();
        ParameterParsingMatchesApacheEncodedWordCases();
        MimeDecodersMatchApacheVectors();
        DiskItemsCrossTheConfiguredThreshold();
        UploadParsesFieldsAndFilesInWireOrder();
        UploadAcceptsCommaSeparatedBoundaryParameter();
        UploadUnfoldsHeadersAndReportsProgress();
        UploadFlattensNestedMultipartMixed();
        UploadItemIteratorPreservesOrder();
        UploadPreservesVariableSizedParts();
        UploadRejectsConfiguredLimits();
        UploadRejectsMissingBoundaryAndTruncatedBody();
        Console.WriteLine("commons-fileupload-csharp regression tests passed");
        return 0;
    }

    private static void ParameterParsingPreservesQuotedValues()
    {
        var parser = new ParameterParser();
        parser.SetLowerCaseNames(true);
        var values = parser.Parse("FORM-DATA; name=note; filename=\"a;b.txt\"", ';');
        Assert(values["name"] == "note", "field parameter was not parsed");
        Assert(values["filename"] == "a;b.txt", "quoted filename was split at its separator");
    }

    private static void ParameterParsingMatchesApacheEncodedWordCases()
    {
        const string encodedFileName = "=?ISO-8859-1?B?SWYgeW91IGNhbiByZWFkIHRoaXMgeW8=?= =?ISO-8859-2?B?dSB1bmRlcnN0YW5kIHRoZSBleGFtcGxlLg==?=";
        var parser = new ParameterParser();
        Assert(parser.Parse("param = \"stuff\\\"; more stuff\"", ';')["param"] == "stuff\\\"; more stuff", "escaped quoted parameter differs");
        Assert(parser.Parse("Content-type: multipart/mixed, boundary=BbC04y", ',', ';')["boundary"] == "BbC04y", "mixed boundary was not parsed");
        Assert(parser.Parse($"form-data; filename=\"{encodedFileName}\"", ';')["filename"] == "If you can read this you understand the example.", "RFC 2047 filename differs");
        Assert(MimeUtility.DecodeText("=?UTF-8?Q?_h=C3=A9!_=C3=A0=C3=A8=C3=B4u_!!!?=") == " hé! àèôu !!!", "quoted-printable header differs");
    }

    private static void MimeDecodersMatchApacheVectors()
    {
        Assert(Base64Decoder.Decode("S?G!V%sbG 8g\rV\t\n29ybGQ*=").SequenceEqual(Encoding.ASCII.GetBytes("Hello World")), "Base64 noise handling differs");
        Assert(Base64Decoder.Decode("SGVsbG8gV29ybGQ=SGVsbG8gV29ybGQ=").SequenceEqual(Encoding.ASCII.GetBytes("Hello WorldHello World")), "Base64 inner padding differs");
        Assert(QuotedPrintableDecoder.Decode("=3D Hello there =3D=0D=0A").SequenceEqual(Encoding.ASCII.GetBytes("= Hello there =\r\n")), "quoted-printable vector differs");
        Assert(QuotedPrintableDecoder.Decode("abc=\r\ndef").SequenceEqual(Encoding.ASCII.GetBytes("abcdef")), "quoted-printable soft break differs");
        Expect<InvalidDataException>(() => Base64Decoder.Decode("n"), "truncated Base64 was accepted");
        Expect<InvalidDataException>(() => QuotedPrintableDecoder.Decode("=XD"), "invalid quoted-printable was accepted");
        Expect<ArgumentException>(() => MimeUtility.DecodeText("=?invalid?B?xyz-?="), "invalid MIME charset was accepted");
    }

    private static void DiskItemsCrossTheConfiguredThreshold()
    {
        var repository = Path.Combine(Path.GetTempPath(), "commons-fileupload-csharp-tests", Guid.NewGuid().ToString("N"));
        var item = new DiskFileItem("upload", "text/plain; charset=UTF-8", false, "a.txt", 3, repository);
        using (var output = item.GetOutputStream())
        {
            output.Write(Encoding.UTF8.GetBytes("hello"));
        }
        Assert(!item.IsInMemory(), "item above threshold must spill to disk");
        Assert(item.GetString() == "hello", "disk-backed item content differs");
        item.Delete();
        Directory.Delete(repository, recursive: true);
    }

    private static void UploadParsesFieldsAndFilesInWireOrder()
    {
        const string body = "--AaB03x\r\n"
            + "Content-Disposition: form-data; name=\"title\"\r\n\r\n"
            + "report\r\n"
            + "--AaB03x\r\n"
            + "Content-Disposition: form-data; name=\"upload\"; filename=\"a.txt\"\r\n"
            + "Content-Type: text/plain\r\n\r\n"
            + "hello\r\n"
            + "--AaB03x--\r\n";
        var upload = new FileUpload(new DiskFileItemFactory(1024, Path.GetTempPath()));
        var items = upload.ParseRequest(new MemoryRequestContext(body, "multipart/form-data; boundary=AaB03x"));
        Assert(items.Count == 2, "multipart parts were not preserved");
        Assert(items[0].IsFormField() && items[0].GetString() == "report", "form field differs");
        Assert(!items[1].IsFormField() && items[1].GetName() == "a.txt", "file item differs");
        Assert(items[1].GetString() == "hello", "file body differs");
    }

    private static void UploadAcceptsCommaSeparatedBoundaryParameter()
    {
        const string body = "--comma-boundary\r\n"
            + "Content-Disposition: form-data; name=\"title\"\r\n\r\n"
            + "report\r\n"
            + "--comma-boundary--\r\n";
        var upload = new FileUpload(new DiskFileItemFactory());
        var items = upload.ParseRequest(new MemoryRequestContext(body, "multipart/form-data, boundary=comma-boundary"));
        Assert(items.Count == 1 && items[0].GetString() == "report", "comma-separated boundary differs");
    }

    private static void UploadUnfoldsHeadersAndReportsProgress()
    {
        const string body = "--AaB03x\r\n"
            + "Content-Disposition: form-data;\r\n"
            + " name=\"note\"\r\n"
            + "X-Trace: first\r\n"
            + "X-Trace: second\r\n\r\n"
            + "value\r\n"
            + "--AaB03x--\r\n";
        var events = new List<(long Read, long Total, int Count)>();
        var upload = new FileUpload(new DiskFileItemFactory());
        upload.SetProgressListener((read, total, count) => events.Add((read, total, count)));
        var items = upload.ParseRequest(new MemoryRequestContext(body, "multipart/form-data; boundary=AaB03x"));
        Assert(items[0].GetFieldName() == "note", "folded content-disposition differs");
        Assert(ReadAll(items[0].GetHeaders()!.GetHeaders("x-trace")).SequenceEqual(new[] { "first", "second" }), "repeated headers differ");
        Assert(events.SequenceEqual(new[] { (5L, (long)Encoding.UTF8.GetByteCount(body), 1) }), "progress event differs");
    }

    private static void UploadFlattensNestedMultipartMixed()
    {
        const string body = "--AaB03x\r\n"
            + "content-disposition: form-data; name=\"field1\"\r\n\r\n"
            + "Joe Blow\r\n"
            + "--AaB03x\r\n"
            + "content-disposition: form-data; name=\"pics\"\r\n"
            + "Content-type: multipart/mixed; boundary=BbC04y\r\n\r\n"
            + "--BbC04y\r\n"
            + "Content-disposition: attachment; filename=\"file1.txt\"\r\n"
            + "Content-Type: text/plain\r\n\r\n"
            + "... contents of file1.txt ...\r\n"
            + "--BbC04y\r\n"
            + "Content-disposition: attachment; filename=\"file2.gif\"\r\n"
            + "Content-type: image/gif\r\n"
            + "Content-Transfer-Encoding: binary\r\n\r\n"
            + "...contents of file2.gif...\r\n"
            + "--BbC04y--\r\n"
            + "--AaB03x--";
        var upload = new FileUpload(new DiskFileItemFactory());
        var items = upload.ParseRequest(new MemoryRequestContext(body, "multipart/form-data; boundary=AaB03x"));
        Assert(items.Select(item => item.GetFieldName()).SequenceEqual(new[] { "field1", "pics", "pics" }), "mixed field names differ");
        Assert(items.Select(item => item.GetName()).SequenceEqual(new string?[] { null, "file1.txt", "file2.gif" }), "mixed filenames differ");
        Assert(items.Select(item => item.GetString()).SequenceEqual(new[] { "Joe Blow", "... contents of file1.txt ...", "...contents of file2.gif..." }), "mixed bodies differ");
    }

    private static void UploadItemIteratorPreservesOrder()
    {
        const string body = "--AaB03x\r\n"
            + "Content-Disposition: form-data; name=\"title\"\r\n\r\n"
            + "report\r\n"
            + "--AaB03x\r\n"
            + "Content-Disposition: form-data; name=\"upload\"; filename=\"note.txt\"\r\n\r\n"
            + "hello\r\n"
            + "--AaB03x--\r\n";
        var upload = new FileUpload(new DiskFileItemFactory());
        var iterator = upload.GetItemIterator(new MemoryRequestContext(body, "multipart/form-data; boundary=AaB03x"));
        Assert(iterator.HasNext() && iterator.HasNext(), "iterator lookahead differs");
        var first = iterator.Next();
        Assert(first.GetFieldName() == "title", "iterator field differs");
        Assert(ReadStream(first.OpenStream()) == "report", "iterator body differs");
        Assert(iterator.HasNext() && iterator.Next().GetName() == "note.txt", "iterator second item differs");
        Assert(!iterator.HasNext(), "iterator should be exhausted");
        Expect<InvalidOperationException>(() => iterator.Next(), "iterator returned an item after exhaustion");
    }

    private static void UploadPreservesVariableSizedParts()
    {
        var sizes = new[] { 0, 1, 15, 16, 31, 1024 };
        var body = new StringBuilder();
        for (var index = 0; index < sizes.Length; index++)
        {
            body.Append($"--sizes\r\nContent-Disposition: form-data; name=\"field{index}\"\r\n\r\n");
            body.Append(new string((char)('a' + index), sizes[index]));
            body.Append("\r\n");
        }
        body.Append("--sizes--\r\n");
        var items = new FileUpload(new DiskFileItemFactory()).ParseRequest(
            new MemoryRequestContext(body.ToString(), "multipart/form-data; boundary=sizes"));
        Assert(items.Select(item => item.GetSize()).SequenceEqual(sizes.Select(size => (long)size)), "variable sizes differ");
        for (var index = 0; index < sizes.Length; index++)
        {
            Assert(ReadStream(items[index].GetInputStream()) == new string((char)('a' + index), sizes[index]), "variable body differs");
        }
    }

    private static void UploadRejectsConfiguredLimits()
    {
        const string body = "--b\r\nContent-Disposition: form-data; name=\"one\"\r\n\r\na\r\n--b--\r\n";
        var upload = new FileUpload(new DiskFileItemFactory());
        upload.SetFileCountMax(0);
        try
        {
            upload.ParseRequest(new MemoryRequestContext(body, "multipart/form-data; boundary=b"));
            throw new InvalidOperationException("expected file count rejection");
        }
        catch (FileCountLimitExceededException)
        {
            // Expected.
        }

        upload.SetFileCountMax(-1);
        upload.SetFileSizeMax(0);
        try
        {
            upload.ParseRequest(new MemoryRequestContext(body, "multipart/form-data; boundary=b"));
            throw new InvalidOperationException("expected file size rejection");
        }
        catch (FileUploadBase.FileSizeLimitExceededException)
        {
            // Expected.
        }
    }

    private static void UploadRejectsMissingBoundaryAndTruncatedBody()
    {
        var upload = new FileUpload(new DiskFileItemFactory());
        try
        {
            upload.ParseRequest(new MemoryRequestContext("unused", "multipart/form-data"));
            throw new InvalidOperationException("expected missing-boundary rejection");
        }
        catch (FileUploadBase.InvalidContentTypeException)
        {
            // Expected.
        }
        try
        {
            upload.ParseRequest(new MemoryRequestContext("--b\r\nContent-Disposition: form-data; name=\"field\"\r\n\r\nvalue", "multipart/form-data; boundary=b"));
            throw new InvalidOperationException("expected malformed-stream rejection");
        }
        catch (MultipartStream.MalformedStreamException)
        {
            // Expected.
        }
    }

    private sealed class MemoryRequestContext : UploadContext
    {
        private readonly byte[] body;
        private readonly string contentType;

        public MemoryRequestContext(string body, string contentType)
        {
            this.body = Encoding.UTF8.GetBytes(body);
            this.contentType = contentType;
        }

        public string? GetCharacterEncoding() => "UTF-8";
        public string? GetContentType() => contentType;
        public int GetContentLength() => body.Length;
        public long ContentLength() => body.LongLength;
        public Stream GetInputStream() => new MemoryStream(body, writable: false);
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static void Expect<TException>(Action action, string message) where TException : Exception
    {
        try
        {
            action();
            throw new InvalidOperationException(message);
        }
        catch (TException)
        {
            // Expected.
        }
    }

    private static List<string> ReadAll(IEnumerator<string> values)
    {
        var result = new List<string>();
        while (values.MoveNext()) result.Add(values.Current);
        return result;
    }

    private static string ReadStream(Stream stream)
    {
        using (stream)
        using (var reader = new StreamReader(stream, Encoding.UTF8)) return reader.ReadToEnd();
    }
}
