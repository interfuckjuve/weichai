// Derived behaviorally from Apache Commons FileUpload 1.5.
// SPDX-License-Identifier: Apache-2.0
namespace Apache.Commons.FileUpload;

/// 作为 .NET 上传入口，它把表单分段交给可替换的条目工厂。
public class FileUpload : FileUploadBase
{
    private FileItemFactory? fileItemFactory;

    public FileUpload() { }

    public FileUpload(FileItemFactory fileItemFactory)
    {
        this.fileItemFactory = fileItemFactory;
    }

    public override FileItemFactory? GetFileItemFactory() => fileItemFactory;

    public override void SetFileItemFactory(FileItemFactory factory)
    {
        fileItemFactory = factory;
    }
}
