# Code Context

修改文件上传总大小限制和单个文件大小限制

## Snapshots

- commons-fileupload-ts: repo-5d3a3666-bcc4-40ac-bfbb-4a6086735bc2@analysis-7f83867a-101c-4052-ae76-4f008c95cbb2 project=project-e4b237732aca70e0c9ff85d5 analysis=98db443599225ab13d045dbbc28b301e077a97f1c13e8368dcbef4d6c9bd1be0

- commons-fileupload: repo-8aebe03e-4e5a-4e85-a41c-1ae853476e9b@analysis-b39ffb1a-a410-42f6-8749-dbc913bafa08 project=project-a61821301eaff059b0967198 analysis=703881cf9739849a95cf6482a59b5519b1315dfe3c9cc9ad1380acdb14dde6a7

## Retrieval
auto -> module, function, class (automatic)
Automatic granularity follows the highest-ranked available declaration and module evidence; dependency context may cross granularities.

## Relevant Implementations

- package [module] repo-5d3a3666-bcc4-40ac-bfbb-4a6086735bc2@analysis-7f83867a-101c-4052-ae76-4f008c95cbb2:src/file-upload.ts
  Matched this node summary. package: 5 files, 262 declarations.

- disk [module] repo-8aebe03e-4e5a-4e85-a41c-1ae853476e9b@analysis-b39ffb1a-a410-42f6-8749-dbc913bafa08:src/main/java/org/apache/commons/fileupload/disk/DiskFileItem.java
  Matched this node summary. disk: 3 files, 62 declarations.

- parseRequest [function] repo-5d3a3666-bcc4-40ac-bfbb-4a6086735bc2@analysis-7f83867a-101c-4052-ae76-4f008c95cbb2:src/file-upload.ts
  Matched indexed declaration evidence.

- org.apache.commons.fileupload.FileUploadBase.SizeLimitExceededException.SizeLimitExceededException [function] repo-8aebe03e-4e5a-4e85-a41c-1ae853476e9b@analysis-b39ffb1a-a410-42f6-8749-dbc913bafa08:src/main/java/org/apache/commons/fileupload/FileUploadBase.java
  Matched indexed declaration evidence.

- org.apache.commons.fileupload.FileUploadBase [class] repo-8aebe03e-4e5a-4e85-a41c-1ae853476e9b@analysis-b39ffb1a-a410-42f6-8749-dbc913bafa08:src/main/java/org/apache/commons/fileupload/FileUploadBase.java
  Matched indexed implementation and declaration evidence.

- SizeException [class] repo-5d3a3666-bcc4-40ac-bfbb-4a6086735bc2@analysis-7f83867a-101c-4052-ae76-4f008c95cbb2:src/file-upload.ts
  Matched indexed implementation and declaration evidence.

- Local files [module] repo-8aebe03e-4e5a-4e85-a41c-1ae853476e9b@analysis-b39ffb1a-a410-42f6-8749-dbc913bafa08:src/main/java/org/apache/commons/fileupload/FileUploadBase.java
  Matched this node summary. Local files: 20 files, 320 declarations.

- RequestContext.getContentLength [function] repo-5d3a3666-bcc4-40ac-bfbb-4a6086735bc2@analysis-7f83867a-101c-4052-ae76-4f008c95cbb2:src/file-upload.ts
  Matched indexed declaration evidence.

- org.apache.commons.fileupload.FileUploadBase.SizeException [class] repo-8aebe03e-4e5a-4e85-a41c-1ae853476e9b@analysis-b39ffb1a-a410-42f6-8749-dbc913bafa08:src/main/java/org/apache/commons/fileupload/FileUploadBase.java
  Matched indexed implementation and declaration evidence.

- org.apache.commons.fileupload.FileUploadBase.SizeLimitExceededException.SizeLimitExceededException [function] repo-8aebe03e-4e5a-4e85-a41c-1ae853476e9b@analysis-b39ffb1a-a410-42f6-8749-dbc913bafa08:src/main/java/org/apache/commons/fileupload/FileUploadBase.java
  Matched indexed declaration evidence.

## Relations

- repo-5d3a3666-bcc4-40ac-bfbb-4a6086735bc2@analysis-7f83867a-101c-4052-ae76-4f008c95cbb2: symbol:27950089b604ee833026a562 --export (resolved, syntactic)--> SizeLimitExceededException

- repo-5d3a3666-bcc4-40ac-bfbb-4a6086735bc2@analysis-7f83867a-101c-4052-ae76-4f008c95cbb2: symbol:5ff88dede5f984e205426931 --export (resolved, syntactic)--> ServletFileUpload

- repo-5d3a3666-bcc4-40ac-bfbb-4a6086735bc2@analysis-7f83867a-101c-4052-ae76-4f008c95cbb2: tests/file-upload.test.ts --import (unresolved, unresolved)--> node:test

- repo-5d3a3666-bcc4-40ac-bfbb-4a6086735bc2@analysis-7f83867a-101c-4052-ae76-4f008c95cbb2: symbol:27da4d54933b114d0d0ce999 --export (resolved, syntactic)--> MultipartPart

## parseRequest [implementation]
repo-5d3a3666-bcc4-40ac-bfbb-4a6086735bc2@analysis-7f83867a-101c-4052-ae76-4f008c95cbb2:src/file-upload.ts:397:3-449:4
Evidence: source-c3f5ef5fc766cae77bcd0184f4fdd936512fc2af1437f7ca21ee0d8e42f739da; SHA256: da4194fcacdc9c89b32e863c1944bc7c052d64675fd7bc4ba0dccd1a346d2fbc; structural
Matched indexed declaration evidence.

```
parseRequest(context: RequestContext): FileItem[] {
    const requestSize = context.getContentLength();
    if (this.sizeMax >= 0 && requestSize >= 0 && requestSize > this.sizeMax) {
      throw new SizeLimitExceededException('Request exceeds configured maximum size.', requestSize, this.sizeMax);
    }
    const factory = this.getFileItemFactory();
    if (!factory) throw new FileUploadException('No FileItemFactory has been set.');
    const boundary = FileUploadBase.getBoundary(context.getContentType());
    if (!boundary) throw new InvalidContentTypeException('No multipart boundary was found.');

    const items: FileItem[] = [];
    try {
      const addItem = (fieldName: string, headers: FileItemHeaders, body: Buffer, fileName: string | undefined): void => {
        if (this.fileCountMax >= 0 && items.length >= this.fileCountMax) {
          throw new FileCountLimitExceededException('Attachment count exceeds configured maximum.', this.fileCountMax);
        }
        if (this.fileSizeMax >= 0 && body.length > this.fileSizeMax) {
          throw new FileSizeLimitExceededException(`The field ${fieldName} exceeds its maximum permitted size.`, body.length, this.fileSizeMax);
        }
        const item = factory.createItem(fieldName, headers.getHeader(FileUploadBase.CONTENT_TYPE), fileName === undefined, fileName);
        if (item instanceof DiskFileItem) item.store(body);
        else throw new FileUploadException('This reference requires a writable DiskFileItemFactory.');
        item.setHeaders(headers);
        items.push(item);
        this.progressListener?.(body.length, requestSize, items.length);
      };

      for (const part of new MultipartStream(context.getInputStream(), boundary).readParts()) {
        const headers = FileUploadBase.getParsedHeaders(part.rawHeaders);
        const disposition = FileUploadBase.parseDisposition(headers.getHeader(FileUploadBase.CONTENT_DISPOSITION));
        const fieldName = disposition.get('name');
        if (!fieldName) continue;
        const contentType = headers.getHeader(FileUploadBase.CONTENT_TYPE) ?? '';
        const nestedBoundary = contentType.toLowerCase().startsWith(FileUploadBase.MULTIPART_MIXED)
          ? FileUploadBase.getBoundary(contentType)
          : undefined;
        if (nestedBoundary) {
          for (const nestedPart of new MultipartStream(part.body, nestedBoundary).readParts()) {
            const nestedHeaders = FileUploadBase.getParsedHeaders(nestedPart.rawHeaders);
            const nestedDisposition = FileUploadBase.parseDisposition(nestedHeaders.getHeader(FileUploadBase.CONTENT_DISPOSITION));
            const nestedFileName = nestedDisposition.get('filename');
            if (nestedFileName !== undefined) addItem(fieldName, nestedHeaders, nestedPart.body, nestedFileName);
          }
          continue;
        }
        addItem(fieldName, headers, part.body, disposition.get('filename'));
      }
      return items;
    } catch (error) {
      for (const item of items) item.delete();
      throw error;
    }
  }
```

## org.apache.commons.fileupload.FileUploadBase.SizeLimitExceededException.SizeLimitExceededException [implementation]
repo-8aebe03e-4e5a-4e85-a41c-1ae853476e9b@analysis-b39ffb1a-a410-42f6-8749-dbc913bafa08:src/main/java/org/apache/commons/fileupload/FileUploadBase.java:1435:9-1438:10
Evidence: source-b0e9d2fe01e9af8d0b4ad6d95c18301b757bd35c7750df9d93f8ce71e6e7b846; SHA256: 3295649f34629eee7e67c7278d80c0eb757e2a5e8738fe765da177246ec26bb2; structural
Matched indexed declaration evidence.

```
public SizeLimitExceededException(String message, long actual,
                long permitted) {
            super(message, actual, permitted);
        }
```

## SizeException [implementation]
repo-5d3a3666-bcc4-40ac-bfbb-4a6086735bc2@analysis-7f83867a-101c-4052-ae76-4f008c95cbb2:src/file-upload.ts:35:8-39:2
Evidence: source-dd4c5e4fa75d282c405ca24df1bbbb99007bdd7de0d40da02aef0bfea15ea22a; SHA256: 280bad4b95ed2f007ab3755b9bb8c57562c1098eed4eac2205d09cb915c59779; structural
Matched indexed implementation and declaration evidence.

```
class SizeException extends FileUploadException {
  constructor(message: string, readonly actualSize: number, readonly permittedSize: number) {
    super(message);
  }
}
```

## RequestContext.getContentLength [implementation]
repo-5d3a3666-bcc4-40ac-bfbb-4a6086735bc2@analysis-7f83867a-101c-4052-ae76-4f008c95cbb2:src/file-upload.ts:61:3-61:29
Evidence: source-9061ca8168d154fea47ada11bc48f525c65f9cbd906ecbf0c61584bcf6467c8d; SHA256: d3e9337c389fb46c7c83129eeb5e390e3b3ca67b9f8fc176882dee2ecbcc0e95; structural
Matched indexed declaration evidence.

```
getContentLength(): number
```

## org.apache.commons.fileupload.FileUploadBase.SizeLimitExceededException.SizeLimitExceededException [implementation]
repo-8aebe03e-4e5a-4e85-a41c-1ae853476e9b@analysis-b39ffb1a-a410-42f6-8749-dbc913bafa08:src/main/java/org/apache/commons/fileupload/FileUploadBase.java:1422:9-1425:10
Evidence: source-157ddd77d211f6ee41ec793a7b2c08bf2f3db2dacac4a57752aa625dfde2e36f; SHA256: fafb8e6dfb7e4ee939299f89d1575563264211dfa0c3b37a8868163bd1c87ae6; structural
Matched indexed declaration evidence.

```
@Deprecated
        public SizeLimitExceededException(String message) {
            this(message, 0, 0);
        }
```

## SizeLimitExceededException [implementation]
repo-5d3a3666-bcc4-40ac-bfbb-4a6086735bc2@analysis-7f83867a-101c-4052-ae76-4f008c95cbb2:src/file-upload.ts:42:8-42:65
Evidence: source-e328b3590076a1d057ea4fd147a3993a077e6e4331238d97e59431440f7c36f2; SHA256: 8512db0277dd88c7661f80b6ad5cc12c012cfc6abc4aa014ba28512922bafa23; structural
Representative implementation within package.

```
class SizeLimitExceededException extends SizeException {}
```

## Gaps

- SYMBOL_CANDIDATES_TRUNCATED: Additional declarations matched the bounded candidate scope.

- SYMBOL_CANDIDATES_TRUNCATED: Additional declarations matched the bounded candidate scope.

- SOURCE_TRUNCATED: Source excerpt is truncated: src/main/java/org/apache/commons/fileupload/FileUploadBase.java

- MODULE_CONTEXT_PARTIAL: Only bounded representative implementation excerpts from package were included; this is not its complete source subtree.

- MODULE_CONTEXT_PARTIAL: Only bounded representative implementation excerpts from disk were included; this is not its complete source subtree.

- MODULE_CONTEXT_PARTIAL: Only bounded representative implementation excerpts from Local files were included; this is not its complete source subtree.

- DEPENDENCY_BUDGET_EXCEEDED: Additional dependencies of package were not expanded.

- UNRESOLVED_DEPENDENCY: tests/file-upload.test.ts: node:test is unresolved.

- UNRESOLVED_DEPENDENCY: tests/file-upload.test.ts: node:assert/strict is unresolved.

- UNRESOLVED_DEPENDENCY: src/file-upload.ts: node:os is unresolved.

- DEPENDENCY_BUDGET_EXCEEDED: Additional dependencies of disk were not expanded.

- UNRESOLVED_DEPENDENCY: src/main/java/org/apache/commons/fileupload/disk/DiskFileItem.java: java.util.Map is unresolved.

- UNRESOLVED_DEPENDENCY: src/main/java/org/apache/commons/fileupload/disk/DiskFileItem.java: java.io.FileOutputStream is unresolved.

- UNRESOLVED_DEPENDENCY: src/main/java/org/apache/commons/fileupload/disk/DiskFileItem.java: java.io.OutputStream is unresolved.

- DEPENDENCY_CONTEXT_PARTIAL: Additional declarations from dependency src/test/java/org/apache/commons/fileupload/Util.java were not included.

- DEPENDENCY_BUDGET_EXCEEDED: Additional dependencies of parseRequest were not expanded.

- UNRESOLVED_DEPENDENCY: src/file-upload.ts: node:fs is unresolved.

- DEPENDENCY_BUDGET_EXCEEDED: Additional dependencies of org.apache.commons.fileupload.FileUploadBase.SizeLimitExceededException.SizeLimitExceededException were not expanded.

- UNRESOLVED_DEPENDENCY: src/main/java/org/apache/commons/fileupload/FileUploadBase.java: java.util.List is unresolved.

- UNRESOLVED_DEPENDENCY: src/main/java/org/apache/commons/fileupload/FileUploadBase.java: java.io.InputStream is unresolved.

- UNRESOLVED_DEPENDENCY: src/main/java/org/apache/commons/fileupload/FileUploadBase.java: java.io.UnsupportedEncodingException is unresolved.

- UNRESOLVED_DEPENDENCY: src/main/java/org/apache/commons/fileupload/FileUploadBase.java: javax.servlet.http.HttpServletRequest is unresolved.

- DEPENDENCY_BUDGET_EXCEEDED: Additional dependencies of org.apache.commons.fileupload.FileUploadBase were not expanded.

- DEPENDENCY_BUDGET_EXCEEDED: Additional dependencies of SizeException were not expanded.

- DEPENDENCY_BUDGET_EXCEEDED: Additional dependencies of Local files were not expanded.

- UNRESOLVED_DEPENDENCY: src/main/java/org/apache/commons/fileupload/DiskFileUpload.java: java.util.List is unresolved.

- UNRESOLVED_DEPENDENCY: src/main/java/org/apache/commons/fileupload/DefaultFileItemFactory.java: java.io.File is unresolved.

- SOURCE_TRUNCATED: Source excerpt is truncated: src/main/java/org/apache/commons/fileupload/MultipartStream.java

- DEPENDENCY_BUDGET_EXCEEDED: Additional dependencies of RequestContext.getContentLength were not expanded.

- DEPENDENCY_BUDGET_EXCEEDED: Additional dependencies of org.apache.commons.fileupload.FileUploadBase.SizeException were not expanded.

- SOURCE_TRUNCATED: Source excerpt is truncated: pom.xml

- CONTEXT_METADATA_TRUNCATED: Some result or relation metadata was omitted to preserve the source evidence budget.

- CONTEXT_BUDGET_EXCEEDED: Additional source evidence was omitted to respect the context budget. Narrow the task or increase the budget.