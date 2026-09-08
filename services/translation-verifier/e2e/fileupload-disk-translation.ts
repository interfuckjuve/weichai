// Method bodies derived from Apache Commons FileUpload 1.5 (Apache-2.0).
// Source: https://repo.maven.apache.org/maven2/commons-fileupload/commons-fileupload/1.5/commons-fileupload-1.5-sources.jar
// LICENSE and NOTICE are retained in the target project snapshot.
const replacements = [
    [
        `        // TODO(translation): return a fresh stream over either the in-memory
        // bytes or the threshold-spilled temporary file.
        throw new UnsupportedOperationException("TODO: open item content stream");`,
        `        if (!isInMemory()) {
            return new FileInputStream(dfos.getFile());
        }
        if (cachedContent == null) {
            cachedContent = dfos.getData();
        }
        return new ByteArrayInputStream(cachedContent);`,
    ],
    [
        `        // TODO(translation): materialize disk-backed content and cache only
        // in-memory content, matching the original failure behavior.
        throw new UnsupportedOperationException("TODO: read item bytes");`,
        `        if (isInMemory()) {
            if (cachedContent == null && dfos != null) {
                cachedContent = dfos.getData();
            }
            return cachedContent;
        }
        byte[] fileData = new byte[(int) getSize()];
        InputStream fis = null;
        try {
            fis = new FileInputStream(dfos.getFile());
            IOUtils.readFully(fis, fileData);
        } catch (IOException e) {
            fileData = null;
        } finally {
            IOUtils.closeQuietly(fis);
        }
        return fileData;`,
    ],
    [
        `        // TODO(translation): copy memory-backed data and move disk-backed
        // data exactly once, retaining the cached length after a move.
        throw new UnsupportedOperationException("TODO: persist uploaded item");`,
        `        if (isInMemory()) {
            FileOutputStream fout = null;
            try {
                fout = new FileOutputStream(file);
                fout.write(get());
                fout.close();
            } finally {
                IOUtils.closeQuietly(fout);
            }
        } else {
            File outputFile = getStoreLocation();
            if (outputFile != null) {
                size = outputFile.length();
                if (file.exists()) {
                    file.delete();
                }
                FileUtils.moveFile(outputFile, file);
            } else {
                throw new FileUploadException(
                    "Cannot write uploaded file to disk!");
            }
        }`,
    ],
    [
        `        // TODO(translation): create the deferred output stream at first use;
        // the configured threshold controls the memory-to-disk transition.
        throw new UnsupportedOperationException("TODO: create item output stream");`,
        `        if (dfos == null) {
            File outputFile = getTempFile();
            dfos = new DeferredFileOutputStream(sizeThreshold, outputFile);
        }
        return dfos;`,
    ],
] as const;

export function translatedDiskJava(original: string): string {
    // Restore the four-method dependency closure so tests exercise real storage.
    for (const [anchor, body] of replacements) {
        if (original.split(anchor).length !== 2)
            throw new Error(
                "DiskFileItem TODO changed; review benchmark patch.",
            );
        original = original.replace(anchor, body);
    }
    return original;
}
