# Apache Commons FileUpload 1.5 Java Skeleton

This target workspace is derived from the official Apache Commons FileUpload 1.5 source
release. It preserves the upstream package layout, public API, test suite,
LICENSE, and NOTICE so that retrieval and translation operate on a realistic
Java project.

The following upstream behavior is deliberately removed and represented by
`UnsupportedOperationException` TODOs:

- multipart iterator construction and request materialization in `FileUploadBase`;
- RFC header parameter parsing in `ParameterParser`;
- preamble/body handling in `MultipartStream`;
- deferred memory-to-disk storage in `DiskFileItem`.

All files in `src/test/java` are Apache's original JUnit 4 tests from version
1.5. They are retained unchanged as the acceptance oracle. Running them against
this skeleton is expected to fail until the TODOs are implemented.

## Commands

```text
mvn test
```

`pom.xml` is a minimal execution POM containing the upstream dependencies:
Commons IO, Servlet API, Portlet API, and JUnit 4. The original release POM is
preserved as `UPSTREAM-pom.xml`; source provenance is recorded in `UPSTREAM.md`.
