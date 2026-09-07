import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFromFile } from "json-schema-to-typescript";

const schemaPath = fileURLToPath(
  new URL("../src/schemas/verification-run.schema.json", import.meta.url),
);
const outputPath = fileURLToPath(
  new URL("../src/schemas/verification-schema-types.d.ts", import.meta.url),
);
const declaration = await compileFromFile(schemaPath, {
  bannerComment: "/* Generated from verifier JSON Schemas. Do not edit. */",
  unreachableDefinitions: true,
  unknownAny: true,
  $refOptions: { resolve: { http: false } },
});

if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (existing !== declaration) {
    throw new Error(
      "Verifier schema types are stale. Run npm run generate:schema-types --workspace @forexplore/translation-verifier.",
    );
  }
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, declaration, "utf8");
}
