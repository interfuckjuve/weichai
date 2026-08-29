import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  CompilerProbeDiagnostic,
  CompilerProbeRequest,
  CompilerProbeResult,
  SemanticDependencyBinding,
} from './repository-analysis.js';

const execFileAsync = promisify(execFile);

const compilerTimeoutMs = 60_000;
const maxCompilerOutputBytes = 8 * 1024 * 1024;

interface ManifestCandidate {
  binding: SemanticDependencyBinding;
  id: number;
}

interface ProbeProtocolResult {
  bindings: SemanticDependencyBinding[];
  compiler?: string;
  diagnostics: CompilerProbeDiagnostic[];
  status: CompilerProbeResult['status'];
}

function encodeField(value: string | undefined): string {
  return Buffer.from(value ?? '', 'utf8').toString('base64');
}

function decodeField(value: string | undefined): string {
  if (!value) return '';
  return Buffer.from(value, 'base64').toString('utf8');
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) {
    const details = error.message.trim().replace(/\s+/g, ' ');
    return details.slice(0, 2_000);
  }
  return String(error).trim().replace(/\s+/g, ' ').slice(0, 2_000);
}

function commandFailureOutput(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const candidate = error as { stderr?: string | Buffer; stdout?: string | Buffer };
  const output = [candidate.stderr, candidate.stdout]
    .filter((value): value is string | Buffer => value !== undefined)
    .map((value) => value.toString())
    .join('\n')
    .trim()
    .replace(/\s+/g, ' ');
  return output.slice(0, 2_000);
}

function compilerFailure(
  language: 'Java' | 'C#',
  code: string,
  error: unknown,
): CompilerProbeResult {
  const output = commandFailureOutput(error);
  return {
    status: 'failed',
    diagnostics: [{
      severity: 'warn',
      code,
      message: `${language} semantic compiler probe failed: ${safeMessage(error)}${output ? ` (${output})` : ''}`,
    }],
    bindings: [],
  };
}

async function withTemporaryDirectory<T>(
  prefix: string,
  action: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await action(directory);
  } finally {
    try {
      await rm(directory, { force: true, recursive: true, maxRetries: 2, retryDelay: 100 });
    } catch {
      // Temporary probe output is outside the repository and never changes evidence.
    }
  }
}

function manifestContents(request: CompilerProbeRequest, candidates: ManifestCandidate[]): string {
  const lines = ['FOREXPLORE_SEMANTIC_PROBE_V1'];
  for (const file of request.files) {
    lines.push([
      'F',
      encodeField(file.path),
      encodeField(path.resolve(request.root, file.path)),
      encodeField(file.project),
    ].join('\t'));
  }
  for (const candidate of candidates) {
    const range = candidate.binding.evidenceRange;
    lines.push([
      'C',
      String(candidate.id),
      encodeField(candidate.binding.sourcePath),
      encodeField(candidate.binding.targetPath),
      encodeField(candidate.binding.kind),
      String(range.startLine),
      String(range.startColumn ?? 1),
      String(range.endLine ?? range.startLine),
      String(range.endColumn ?? range.startColumn ?? 1),
      encodeField(candidate.binding.targetSymbolId),
    ].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

function parseProtocol(
  language: 'Java' | 'C#',
  output: string,
  candidates: ManifestCandidate[],
): ProbeProtocolResult {
  const candidateById = new Map(candidates.map((candidate) => [String(candidate.id), candidate.binding]));
  const bindingIds = new Set<string>();
  const diagnostics: CompilerProbeDiagnostic[] = [];
  let compiler: string | undefined;
  let status: CompilerProbeResult['status'] = 'failed';
  let receivedStatus = false;

  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine) continue;
    const fields = rawLine.split('\t');
    const record = fields[0];
    if (record === 'STATUS') {
      const candidateStatus = fields[1];
      if (candidateStatus === 'available' || candidateStatus === 'unavailable' || candidateStatus === 'failed') {
        status = candidateStatus;
        compiler = decodeField(fields[2]) || undefined;
        receivedStatus = true;
      } else {
        diagnostics.push({
          severity: 'warn',
          code: `${language === 'Java' ? 'JAVA' : 'CSHARP'}_SEMANTIC_PROTOCOL_INVALID_STATUS`,
          message: `${language} semantic compiler probe returned an invalid status.`,
        });
      }
      continue;
    }
    if (record === 'B') {
      const id = fields[1] ?? '';
      if (candidateById.has(id)) bindingIds.add(id);
      else {
        diagnostics.push({
          severity: 'warn',
          code: `${language === 'Java' ? 'JAVA' : 'CSHARP'}_SEMANTIC_PROTOCOL_UNKNOWN_BINDING`,
          message: `${language} semantic compiler probe returned an unknown candidate binding.`,
        });
      }
      continue;
    }
    if (record === 'D') {
      const severity = fields[1];
      const code = fields[2];
      const message = decodeField(fields[3]);
      const diagnosticPath = decodeField(fields[4]);
      if (
        (severity === 'info' || severity === 'warn' || severity === 'error') &&
        code &&
        message
      ) {
        diagnostics.push({
          severity,
          code,
          message,
          ...(diagnosticPath ? { path: diagnosticPath } : {}),
        });
      }
      continue;
    }
  }

  if (!receivedStatus) {
    diagnostics.push({
      severity: 'warn',
      code: `${language === 'Java' ? 'JAVA' : 'CSHARP'}_SEMANTIC_PROTOCOL_INVALID`,
      message: `${language} semantic compiler probe did not return a valid protocol status.`,
    });
  }
  const bindings = [...bindingIds]
    .sort((left, right) => Number(left) - Number(right))
    .flatMap((id) => {
      const binding = candidateById.get(id);
      return binding ? [binding] : [];
    });
  return { bindings, compiler, diagnostics, status };
}

const javaProbeSource = String.raw`
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.tree.Tree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import java.io.BufferedReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import javax.lang.model.element.Element;
import javax.lang.model.element.PackageElement;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

public final class ForeXploreJavaSemanticProbe {
  private static final class FileRecord {
    final String relative;
    final Path absolute;
    FileRecord(String relative, Path absolute) {
      this.relative = relative;
      this.absolute = absolute;
    }
  }

  private static final class Candidate {
    final int id;
    final String source;
    final String target;
    final String kind;
    final String targetSymbolId;
    final int startLine;
    final int startColumn;
    final int endLine;
    final int endColumn;
    Candidate(int id, String source, String target, String kind, int startLine, int startColumn, int endLine, int endColumn, String targetSymbolId) {
      this.id = id;
      this.source = source;
      this.target = target;
      this.kind = kind;
      this.targetSymbolId = targetSymbolId;
      this.startLine = startLine;
      this.startColumn = startColumn;
      this.endLine = endLine;
      this.endColumn = endColumn;
    }
  }

  private static String decode(String value) {
    return new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
  }

  private static String encode(String value) {
    return Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8));
  }

  private static void diagnostic(String severity, String code, String message, String source) {
    System.out.println("D\t" + severity + "\t" + code + "\t" + encode(message) + "\t" + encode(source));
  }

  private static String normalized(Path value) {
    return value.toAbsolutePath().normalize().toString();
  }

  private static long position(CharSequence source, int line, int column) {
    if (line < 1 || column < 1) return -1L;
    int currentLine = 1;
    int index = 0;
    while (index < source.length() && currentLine < line) {
      if (source.charAt(index++) == '\n') currentLine++;
    }
    if (currentLine != line) return -1L;
    long offset = (long) index + column - 1L;
    return offset <= source.length() ? offset : -1L;
  }

  private static TreePath declarationPath(Trees trees, Element element) {
    Element current = element;
    while (current != null) {
      TreePath path = trees.getPath(current);
      if (path != null) return path;
      current = current.getEnclosingElement();
    }
    return null;
  }

  private static String qualifiedElementName(Element element) {
    if (element instanceof PackageElement) return ((PackageElement) element).getQualifiedName().toString();
    List<String> pieces = new ArrayList<>();
    Element current = element;
    while (current != null && !(current instanceof PackageElement)) {
      String name = current.getSimpleName().toString();
      if (!name.isEmpty()) pieces.add(name);
      current = current.getEnclosingElement();
    }
    if (current instanceof PackageElement) {
      String packageName = ((PackageElement) current).getQualifiedName().toString();
      if (!packageName.isEmpty()) pieces.add(packageName);
    }
    java.util.Collections.reverse(pieces);
    return String.join(".", pieces);
  }

  private static TreePath importPath(CompilationUnitTree unit, SourcePositions positions, long start, long end) {
    for (ImportTree imported : unit.getImports()) {
      Tree identifier = imported.getQualifiedIdentifier();
      long identifierStart = positions.getStartPosition(unit, identifier);
      long identifierEnd = positions.getEndPosition(unit, identifier);
      if (identifierStart == Diagnostic.NOPOS || identifierEnd == Diagnostic.NOPOS) continue;
      if (identifierStart <= start && identifierEnd >= end) return TreePath.getPath(unit, identifier);
    }
    return null;
  }

  private static final class CandidatePathFinder extends TreePathScanner<Void, Void> {
    private final CompilationUnitTree unit;
    private final SourcePositions positions;
    private final long start;
    private final long end;
    private TreePath best;
    private long bestScore = Long.MAX_VALUE;

    CandidatePathFinder(CompilationUnitTree unit, SourcePositions positions, long start, long end) {
      this.unit = unit;
      this.positions = positions;
      this.start = start;
      this.end = end;
    }

    private void consider(Tree node) {
      long nodeStart = positions.getStartPosition(unit, node);
      long nodeEnd = positions.getEndPosition(unit, node);
      if (nodeStart == Diagnostic.NOPOS || nodeEnd == Diagnostic.NOPOS || nodeEnd < nodeStart) return;
      boolean contained = nodeStart >= start && nodeEnd <= end;
      boolean containing = nodeStart <= start && nodeEnd >= end;
      boolean overlaps = nodeStart < end && nodeEnd > start;
      if (!contained && !containing && !overlaps) return;
      long span = Math.max(1L, nodeEnd - nodeStart);
      // For a receiver-qualified reference such as helper.execute, the
      // syntactic range starts at the receiver while the semantic declaration
      // belongs to the terminal member. Prefer a node covering that terminal.
      boolean coversTerminal = nodeStart < end && nodeEnd >= end;
      long score = (coversTerminal ? 0L : 10_000_000L)
        + (contained ? span : containing ? span + 1_000_000L : span + 2_000_000L);
      if (score < bestScore) {
        bestScore = score;
        best = getCurrentPath();
      }
    }

    @Override public Void visitIdentifier(com.sun.source.tree.IdentifierTree node, Void value) {
      consider(node);
      return super.visitIdentifier(node, value);
    }

    @Override public Void visitMemberSelect(com.sun.source.tree.MemberSelectTree node, Void value) {
      consider(node);
      return super.visitMemberSelect(node, value);
    }

    @Override public Void visitParameterizedType(com.sun.source.tree.ParameterizedTypeTree node, Void value) {
      consider(node);
      return super.visitParameterizedType(node, value);
    }

    @Override public Void visitMethodInvocation(com.sun.source.tree.MethodInvocationTree node, Void value) {
      consider(node);
      return super.visitMethodInvocation(node, value);
    }

    @Override public Void visitNewClass(com.sun.source.tree.NewClassTree node, Void value) {
      consider(node);
      return super.visitNewClass(node, value);
    }

    TreePath best() { return best; }
  }

  public static void main(String[] args) throws Exception {
    if (args.length != 1) {
      System.out.println("STATUS\tfailed\t");
      diagnostic("warn", "JAVA_SEMANTIC_PROTOCOL_ARGUMENTS", "Expected one manifest path.", "");
      return;
    }
    Map<String, FileRecord> files = new HashMap<>();
    List<Candidate> candidates = new ArrayList<>();
    try (BufferedReader reader = Files.newBufferedReader(Paths.get(args[0]), StandardCharsets.UTF_8)) {
      String line;
      while ((line = reader.readLine()) != null) {
        String[] fields = line.split("\\t", -1);
        if (fields.length == 0) continue;
        if ("F".equals(fields[0]) && fields.length >= 3) {
          String relative = decode(fields[1]);
          files.put(relative, new FileRecord(relative, Paths.get(decode(fields[2]))));
        } else if ("C".equals(fields[0]) && fields.length >= 10) {
          candidates.add(new Candidate(
            Integer.parseInt(fields[1]), decode(fields[2]), decode(fields[3]),
            decode(fields[4]), Integer.parseInt(fields[5]), Integer.parseInt(fields[6]),
            Integer.parseInt(fields[7]), Integer.parseInt(fields[8]), decode(fields[9])
          ));
        }
      }
    }

    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    if (compiler == null) {
      System.out.println("STATUS\tunavailable\t");
      diagnostic("info", "JAVA_COMPILER_UNAVAILABLE", "JDK compiler API is unavailable; preserving syntactic dependency evidence.", "");
      return;
    }
    List<Path> sourcePaths = new ArrayList<>();
    for (FileRecord file : files.values()) {
      if (file.relative.endsWith(".java")) sourcePaths.add(file.absolute);
    }
    sourcePaths.sort(Comparator.comparing(ForeXploreJavaSemanticProbe::normalized));
    if (sourcePaths.isEmpty()) {
      System.out.println("STATUS\tavailable\t" + encode(System.getProperty("java.version", "javac")));
      return;
    }

    DiagnosticCollector<JavaFileObject> compilerDiagnostics = new DiagnosticCollector<>();
    try (StandardJavaFileManager manager = compiler.getStandardFileManager(compilerDiagnostics, Locale.ROOT, StandardCharsets.UTF_8)) {
      Iterable<? extends JavaFileObject> units = manager.getJavaFileObjectsFromPaths(sourcePaths);
      List<String> options = List.of("-proc:none", "-implicit:none", "-Xlint:none");
      JavacTask task = (JavacTask) compiler.getTask(null, manager, compilerDiagnostics, options, null, units);
      Iterable<? extends CompilationUnitTree> parsed = task.parse();
      try {
        task.analyze();
      } catch (RuntimeException failure) {
        diagnostic("warn", "JAVA_SEMANTIC_ANALYZE_INCOMPLETE", "JDK semantic analysis completed partially: " + failure.getMessage(), "");
      }
      Trees trees = Trees.instance(task);
      SourcePositions positions = trees.getSourcePositions();
      Map<String, CompilationUnitTree> unitsByPath = new HashMap<>();
      for (CompilationUnitTree unit : parsed) {
        try {
          unitsByPath.put(normalized(Paths.get(unit.getSourceFile().toUri())), unit);
        } catch (Exception ignored) {
          // Non-file source objects cannot prove repository-local bindings.
        }
      }
      Map<String, String> relativeByPath = new HashMap<>();
      for (FileRecord file : files.values()) relativeByPath.put(normalized(file.absolute), file.relative);

      for (Candidate candidate : candidates) {
        FileRecord source = files.get(candidate.source);
        if (source == null) continue;
        CompilationUnitTree unit = unitsByPath.get(normalized(source.absolute));
        if (unit == null) continue;
        CharSequence content;
        try {
          content = unit.getSourceFile().getCharContent(true);
        } catch (Exception ignored) {
          continue;
        }
        long start = position(content, candidate.startLine, candidate.startColumn);
        long end = position(content, candidate.endLine, candidate.endColumn);
        if (start < 0 || end < start) continue;
        end = Math.min(content.length(), end + 1L);
        TreePath candidatePath = "import".equals(candidate.kind)
          ? importPath(unit, positions, start, end)
          : null;
        if (candidatePath == null) {
          CandidatePathFinder finder = new CandidatePathFinder(unit, positions, start, end);
          finder.scan(unit, null);
          candidatePath = finder.best();
        }
        if (candidatePath == null) continue;
        Element element = trees.getElement(candidatePath);
        if (element == null) continue;
        TreePath targetPath = declarationPath(trees, element);
        if (targetPath == null) continue;
        String target;
        try {
          target = relativeByPath.get(normalized(Paths.get(targetPath.getCompilationUnit().getSourceFile().toUri())));
        } catch (Exception ignored) {
          continue;
        }
        if (candidate.target.equals(target) && (
          candidate.targetSymbolId.isEmpty() || candidate.targetSymbolId.endsWith(":" + qualifiedElementName(element))
        )) System.out.println("B\t" + candidate.id);
      }
      int emitted = 0;
      for (Diagnostic<? extends JavaFileObject> item : compilerDiagnostics.getDiagnostics()) {
        if (item.getKind() != Diagnostic.Kind.ERROR || emitted >= 10) continue;
        String source = "";
        try {
          if (item.getSource() != null) source = relativeByPath.getOrDefault(normalized(Paths.get(item.getSource().toUri())), "");
        } catch (Exception ignored) {
          // A diagnostic source outside the repository is informational only.
        }
        diagnostic("warn", "JAVA_SEMANTIC_COMPILER_DIAGNOSTIC", item.getMessage(Locale.ROOT), source);
        emitted++;
      }
      System.out.println("STATUS\tavailable\t" + encode(System.getProperty("java.version", "javac")));
    } catch (Exception failure) {
      diagnostic("warn", "JAVA_SEMANTIC_ANALYSIS_FAILED", failure.getClass().getSimpleName() + ": " + failure.getMessage(), "");
      System.out.println("STATUS\tfailed\t");
    }
  }
}
`;

async function probeJavaCompiler(request: CompilerProbeRequest): Promise<CompilerProbeResult> {
  const candidates = request.candidates.map((binding, id) => ({ binding, id }));
  try {
    return await withTemporaryDirectory('forexplore-java-semantic-', async (directory) => {
      const sourcePath = path.join(directory, 'ForeXploreJavaSemanticProbe.java');
      const manifestPath = path.join(directory, 'manifest.tsv');
      await Promise.all([
        writeFile(sourcePath, javaProbeSource, 'utf8'),
        writeFile(manifestPath, manifestContents(request, candidates), 'utf8'),
      ]);
      try {
        await execFileAsync('javac', ['-d', directory, sourcePath], {
          maxBuffer: maxCompilerOutputBytes,
          timeout: compilerTimeoutMs,
          windowsHide: true,
        });
      } catch (error) {
        const unavailable = (error as NodeJS.ErrnoException).code === 'ENOENT';
        return unavailable
          ? {
            status: 'unavailable',
            diagnostics: [{
              severity: 'info',
              code: 'JAVA_COMPILER_UNAVAILABLE',
              message: 'javac is unavailable; preserving syntactic dependency evidence.',
            }],
            bindings: [],
          }
          : compilerFailure('Java', 'JAVA_SEMANTIC_PROBE_BUILD_FAILED', error);
      }
      try {
        const { stdout } = await execFileAsync('java', ['-cp', directory, 'ForeXploreJavaSemanticProbe', manifestPath], {
          maxBuffer: maxCompilerOutputBytes,
          timeout: compilerTimeoutMs,
          windowsHide: true,
        });
        const result = parseProtocol('Java', stdout, candidates);
        return {
          status: result.status,
          ...(result.compiler ? { compiler: `JDK compiler API ${result.compiler}` } : {}),
          diagnostics: result.diagnostics,
          bindings: result.bindings,
        };
      } catch (error) {
        const unavailable = (error as NodeJS.ErrnoException).code === 'ENOENT';
        return unavailable
          ? {
            status: 'unavailable',
            diagnostics: [{
              severity: 'info',
              code: 'JAVA_RUNTIME_UNAVAILABLE',
              message: 'java is unavailable after locating javac; preserving syntactic dependency evidence.',
            }],
            bindings: [],
          }
          : compilerFailure('Java', 'JAVA_SEMANTIC_PROBE_EXECUTION_FAILED', error);
      }
    });
  } catch (error) {
    return compilerFailure('Java', 'JAVA_SEMANTIC_PROBE_FAILED', error);
  }
}

interface DotnetSdk {
  directory: string;
  version: string;
}

async function newestDotnetSdk(): Promise<DotnetSdk | undefined> {
  try {
    const { stdout } = await execFileAsync('dotnet', ['--list-sdks'], {
      maxBuffer: maxCompilerOutputBytes,
      timeout: 10_000,
      windowsHide: true,
    });
    const sdks = stdout.split(/\r?\n/).flatMap((line) => {
      const match = /^([^\s]+)\s+\[([^\]]+)]\s*$/.exec(line.trim());
      if (!match?.[1] || !match[2]) return [];
      return [{ directory: path.join(match[2], match[1]), version: match[1] }];
    });
    return sdks.sort((left, right) => left.version.localeCompare(right.version, undefined, { numeric: true })).at(-1);
  } catch {
    return undefined;
  }
}

async function recursiveDlls(directory: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [];
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const children = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return recursiveDlls(target, depth + 1);
    return entry.isFile() && entry.name.toLowerCase().endsWith('.dll') ? [target] : [];
  }));
  return children.flat();
}

const requiredRoslynAssemblies = [
  'Microsoft.CodeAnalysis.dll',
  'Microsoft.CodeAnalysis.CSharp.dll',
  'Microsoft.CodeAnalysis.Workspaces.dll',
  'Microsoft.CodeAnalysis.CSharp.Workspaces.dll',
  'Microsoft.CodeAnalysis.Workspaces.MSBuild.dll',
  'Microsoft.Build.Locator.dll',
] as const;

async function locateRoslynAssemblies(sdk: DotnetSdk): Promise<Map<string, string> | undefined> {
  const roots = [
    path.join(sdk.directory, 'DotnetTools', 'dotnet-format'),
    path.join(sdk.directory, 'Roslyn', 'bincore'),
    path.join(sdk.directory, 'DotnetTools'),
  ];
  const dlls = (await Promise.all(roots.map((root) => recursiveDlls(root)))).flat();
  const byName = new Map<string, string>();
  for (const dll of dlls.sort((left, right) => left.localeCompare(right))) {
    const name = path.basename(dll).toLowerCase();
    if (!byName.has(name)) byName.set(name, dll);
  }
  const resolved = new Map<string, string>();
  for (const name of requiredRoslynAssemblies) {
    const file = byName.get(name.toLowerCase());
    if (!file) return undefined;
    resolved.set(name, file);
  }
  return resolved;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function csharpProjectFile(assemblies: Map<string, string>, targetFramework: string): string {
  const references = requiredRoslynAssemblies.map((name, index) => {
    const assembly = assemblies.get(name);
    if (!assembly) throw new Error(`Required Roslyn assembly is missing: ${name}`);
    return [
      `    <Reference Include="ForeXplore${index}">`,
      `      <HintPath>${xmlEscape(assembly)}</HintPath>`,
      '      <Private>true</Private>',
      '    </Reference>',
    ].join('\n');
  }).join('\n');
  return [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    '    <OutputType>Exe</OutputType>',
    `    <TargetFramework>${targetFramework}</TargetFramework>`,
    '    <ImplicitUsings>disable</ImplicitUsings>',
    '    <Nullable>enable</Nullable>',
    '    <RestoreIgnoreFailedSources>true</RestoreIgnoreFailedSources>',
    '  </PropertyGroup>',
    '  <ItemGroup>',
    references,
    '  </ItemGroup>',
    '</Project>',
    '',
  ].join('\n');
}

const csharpProbeSource = String.raw`
#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;

internal sealed class FileRecord {
  internal string Relative { get; }
  internal string Absolute { get; }
  internal string Project { get; }
  internal FileRecord(string relative, string absolute, string project) {
    Relative = relative;
    Absolute = absolute;
    Project = project;
  }
}

internal sealed class Candidate {
  internal int Id { get; }
  internal string Source { get; }
  internal string Target { get; }
  internal string Kind { get; }
  internal string TargetSymbolId { get; }
  internal int StartLine { get; }
  internal int StartColumn { get; }
  internal int EndLine { get; }
  internal int EndColumn { get; }
  internal Candidate(int id, string source, string target, string kind, int startLine, int startColumn, int endLine, int endColumn, string targetSymbolId) {
    Id = id;
    Source = source;
    Target = target;
    Kind = kind;
    TargetSymbolId = targetSymbolId;
    StartLine = startLine;
    StartColumn = startColumn;
    EndLine = endLine;
    EndColumn = endColumn;
  }
}

internal static class Program {
  private static readonly StringComparer PathComparer = StringComparer.OrdinalIgnoreCase;

  private static string Decode(string value) {
    return Encoding.UTF8.GetString(Convert.FromBase64String(value));
  }

  private static string Encode(string value) {
    return Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? string.Empty));
  }

  private static void Diagnostic(string severity, string code, string message, string source = "") {
    Console.WriteLine("D\t" + severity + "\t" + code + "\t" + Encode(message) + "\t" + Encode(source));
  }

  private static string FullPath(string value) {
    return Path.GetFullPath(value);
  }

  private static int Position(SourceText text, int line, int column) {
    if (line < 1 || column < 1 || line > text.Lines.Count) return -1;
    var lineInfo = text.Lines[line - 1];
    var position = lineInfo.Start + column - 1;
    return position <= lineInfo.End ? position : -1;
  }

  private static IEnumerable<ISymbol> SymbolsFor(SemanticModel model, SyntaxNode node) {
    foreach (var current in node.AncestorsAndSelf()) {
      var info = model.GetSymbolInfo(current);
      if (info.Symbol != null) yield return info.Symbol;
      foreach (var candidate in info.CandidateSymbols) yield return candidate;
      var declared = model.GetDeclaredSymbol(current);
      if (declared != null) yield return declared;
    }
  }

  private static string QualifiedSymbolName(ISymbol symbol) {
    if (symbol is INamespaceSymbol) return symbol.ToDisplayString();
    if (symbol.ContainingType != null) return symbol.ContainingType.ToDisplayString() + "." + symbol.Name;
    return symbol.ToDisplayString();
  }

  private static bool IsDeclaredIn(ISymbol symbol, string expectedPath, string targetSymbolId) {
    if (!string.IsNullOrWhiteSpace(targetSymbolId) && !targetSymbolId.EndsWith(":" + QualifiedSymbolName(symbol), StringComparison.Ordinal)) {
      return false;
    }
    foreach (var syntax in symbol.DeclaringSyntaxReferences) {
      var path = syntax.SyntaxTree.FilePath;
      if (!string.IsNullOrWhiteSpace(path) && PathComparer.Equals(FullPath(path), expectedPath)) return true;
    }
    if (symbol.ContainingType != null) return IsDeclaredIn(symbol.ContainingType, expectedPath, targetSymbolId);
    return false;
  }

  private static bool HasProjectReference(Solution solution, Project source, string targetPath) {
    foreach (var reference in source.ProjectReferences) {
      var target = solution.GetProject(reference.ProjectId);
      if (target?.FilePath != null && PathComparer.Equals(FullPath(target.FilePath), targetPath)) return true;
    }
    return false;
  }

  internal static async Task<int> Main(string[] args) {
    if (args.Length != 1) {
      Console.WriteLine("STATUS\tfailed\t");
      Diagnostic("warn", "CSHARP_SEMANTIC_PROTOCOL_ARGUMENTS", "Expected one manifest path.");
      return 0;
    }
    try {
      var files = new Dictionary<string, FileRecord>(StringComparer.Ordinal);
      var candidates = new List<Candidate>();
      foreach (var line in File.ReadLines(args[0], Encoding.UTF8)) {
        var fields = line.Split('\t');
        if (fields.Length == 0) continue;
        if (fields[0] == "F" && fields.Length >= 4) {
          var record = new FileRecord(Decode(fields[1]), Decode(fields[2]), Decode(fields[3]));
          files[record.Relative] = record;
        } else if (fields[0] == "C" && fields.Length >= 10) {
          candidates.Add(new Candidate(
            int.Parse(fields[1]), Decode(fields[2]), Decode(fields[3]), Decode(fields[4]),
            int.Parse(fields[5]), int.Parse(fields[6]), int.Parse(fields[7]), int.Parse(fields[8]), Decode(fields[9])
          ));
        }
      }
      if (!MSBuildLocator.IsRegistered) MSBuildLocator.RegisterDefaults();
      var workspaceProperties = new Dictionary<string, string> {
        ["DesignTimeBuild"] = "true",
        ["BuildingInsideVisualStudio"] = "true",
        ["BuildProjectReferences"] = "false",
        ["SkipCompilerExecution"] = "true",
        ["UseSharedCompilation"] = "false",
        ["RestoreIgnoreFailedSources"] = "true",
      };
      using var workspace = MSBuildWorkspace.Create(workspaceProperties);
      workspace.WorkspaceFailed += (_, eventArgs) =>
        Diagnostic("warn", "CSHARP_MSBUILD_WORKSPACE_DIAGNOSTIC", eventArgs.Diagnostic.Message);

      var reportedLooseSources = new HashSet<string>(StringComparer.Ordinal);
      foreach (var candidate in candidates.Where(candidate => candidate.Kind != "project-reference")) {
        if (files.TryGetValue(candidate.Source, out var source) && string.IsNullOrWhiteSpace(source.Project) && reportedLooseSources.Add(source.Relative)) {
          Diagnostic("warn", "CSHARP_MSBUILD_PROJECT_UNRESOLVED", "The C# source file is not associated with an analysed project, so Roslyn/MSBuildWorkspace cannot prove its bindings.", source.Relative);
        }
      }

      var projectPaths = candidates
        .SelectMany(candidate => new[] { candidate.Source, candidate.Target })
        .Where(relative => relative.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
        .Concat(files.Values.Select(file => file.Project).Where(project => !string.IsNullOrWhiteSpace(project)))
        .Distinct(StringComparer.Ordinal)
        .Select(relative => files.TryGetValue(relative, out var file) ? file.Absolute : Path.Combine(Path.GetDirectoryName(args[0]) ?? string.Empty, relative))
        .Where(File.Exists)
        .OrderBy(value => value, PathComparer)
        .ToList();
      foreach (var projectPath in projectPaths) await workspace.OpenProjectAsync(projectPath);

      var solution = workspace.CurrentSolution;
      var documents = solution.Projects
        .SelectMany(project => project.Documents)
        .Where(document => !string.IsNullOrWhiteSpace(document.FilePath))
        .GroupBy(document => FullPath(document.FilePath!), PathComparer)
        .ToDictionary(group => group.Key, group => group.First(), PathComparer);
      var projects = solution.Projects
        .Where(project => !string.IsNullOrWhiteSpace(project.FilePath))
        .GroupBy(project => FullPath(project.FilePath!), PathComparer)
        .ToDictionary(group => group.Key, group => group.First(), PathComparer);

      foreach (var candidate in candidates) {
        var targetPath = files.TryGetValue(candidate.Target, out var target) ? FullPath(target.Absolute) : string.Empty;
        if (string.IsNullOrWhiteSpace(targetPath)) continue;
        if (candidate.Kind == "project-reference") {
          var sourcePath = files.TryGetValue(candidate.Source, out var sourceProject) ? FullPath(sourceProject.Absolute) : string.Empty;
          if (projects.TryGetValue(sourcePath, out var source) && HasProjectReference(solution, source, targetPath)) {
            Console.WriteLine("B\t" + candidate.Id);
          }
          continue;
        }
        var sourcePathForDocument = files.TryGetValue(candidate.Source, out var sourceFile) ? FullPath(sourceFile.Absolute) : string.Empty;
        if (!documents.TryGetValue(sourcePathForDocument, out var document)) continue;
        var root = await document.GetSyntaxRootAsync();
        var model = await document.GetSemanticModelAsync();
        var text = await document.GetTextAsync();
        if (root == null || model == null) continue;
        var start = Position(text, candidate.StartLine, candidate.StartColumn);
        var end = Position(text, candidate.EndLine, candidate.EndColumn);
        if (start < 0 || end < start) continue;
        var span = TextSpan.FromBounds(start, Math.Min(text.Length, end + 1));
        var node = root.FindNode(span, getInnermostNodeForTie: true, findInsideTrivia: true);
        if (SymbolsFor(model, node).Any(symbol => IsDeclaredIn(symbol, targetPath, candidate.TargetSymbolId))) {
          Console.WriteLine("B\t" + candidate.Id);
        }
      }
      Console.WriteLine("STATUS\tavailable\t" + Encode("Roslyn/MSBuildWorkspace"));
    } catch (Exception failure) {
      Diagnostic("warn", "CSHARP_ROSLYN_MSBUILD_FAILED", failure.GetType().Name + ": " + failure.Message);
      Console.WriteLine("STATUS\tfailed\t");
    }
    return 0;
  }
}
`;

async function copyAssemblyDirectory(sourceDirectory: string, destinationDirectory: string): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(sourceDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.dll'))
    .map(async (entry) => {
      const source = path.join(sourceDirectory, entry.name);
      const destination = path.join(destinationDirectory, entry.name);
      try {
        await copyFile(source, destination, 1);
      } catch {
        // First compatible copy wins. The directly referenced versions are copied by build.
      }
    }));
}

async function probeCsharpCompiler(request: CompilerProbeRequest): Promise<CompilerProbeResult> {
  const sdk = await newestDotnetSdk();
  if (!sdk) {
    return {
      status: 'unavailable',
      diagnostics: [{
        severity: 'info',
        code: 'CSHARP_ROSLYN_MSBUILD_UNAVAILABLE',
        message: 'A .NET SDK with Roslyn/MSBuildWorkspace is unavailable; preserving syntactic dependency evidence.',
      }],
      bindings: [],
    };
  }
  const assemblies = await locateRoslynAssemblies(sdk);
  if (!assemblies) {
    return {
      status: 'unavailable',
      diagnostics: [{
        severity: 'info',
        code: 'CSHARP_ROSLYN_MSBUILD_UNAVAILABLE',
        message: `The .NET SDK ${sdk.version} does not expose the Roslyn/MSBuildWorkspace assemblies needed for semantic analysis; preserving syntactic dependency evidence.`,
      }],
      bindings: [],
    };
  }
  const majorVersion = /^(\d+)/.exec(sdk.version)?.[1];
  if (!majorVersion) {
    return {
      status: 'unavailable',
      diagnostics: [{
        severity: 'info',
        code: 'CSHARP_ROSLYN_MSBUILD_UNAVAILABLE',
        message: `The .NET SDK version ${sdk.version} cannot provide a compatible target framework for the semantic probe.`,
      }],
      bindings: [],
    };
  }
  const targetFramework = `net${majorVersion}.0`;
  const candidates = request.candidates.map((binding, id) => ({ binding, id }));
  try {
    return await withTemporaryDirectory('forexplore-csharp-semantic-', async (directory) => {
      const projectPath = path.join(directory, 'ForeXploreCsharpSemanticProbe.csproj');
      const sourcePath = path.join(directory, 'Program.cs');
      const manifestPath = path.join(directory, 'manifest.tsv');
      await Promise.all([
        writeFile(projectPath, csharpProjectFile(assemblies, targetFramework), 'utf8'),
        writeFile(sourcePath, csharpProbeSource, 'utf8'),
        writeFile(manifestPath, manifestContents(request, candidates), 'utf8'),
      ]);
      const dotnetHome = path.join(directory, 'dotnet-home');
      try {
        await execFileAsync('dotnet', ['build', projectPath, '--nologo', '--verbosity', 'quiet'], {
          cwd: directory,
          env: { ...process.env, DOTNET_CLI_HOME: dotnetHome },
          maxBuffer: maxCompilerOutputBytes,
          timeout: compilerTimeoutMs,
          windowsHide: true,
        });
      } catch (error) {
        return compilerFailure('C#', 'CSHARP_ROSLYN_MSBUILD_PROBE_BUILD_FAILED', error);
      }
      const outputDirectory = path.join(directory, 'bin', 'Debug', targetFramework);
      const sourceDirectories = new Set([...assemblies.values()].map((assembly) => path.dirname(assembly)));
      await Promise.all([...sourceDirectories].map((sourceDirectory) =>
        copyAssemblyDirectory(sourceDirectory, outputDirectory),
      ));
      try {
        const { stdout } = await execFileAsync('dotnet', [
          path.join(outputDirectory, 'ForeXploreCsharpSemanticProbe.dll'),
          manifestPath,
        ], {
          cwd: directory,
          env: { ...process.env, DOTNET_CLI_HOME: dotnetHome },
          maxBuffer: maxCompilerOutputBytes,
          timeout: compilerTimeoutMs,
          windowsHide: true,
        });
        const result = parseProtocol('C#', stdout, candidates);
        return {
          status: result.status,
          ...(result.compiler ? { compiler: result.compiler } : {}),
          diagnostics: result.diagnostics,
          bindings: result.bindings,
        };
      } catch (error) {
        return compilerFailure('C#', 'CSHARP_ROSLYN_MSBUILD_PROBE_EXECUTION_FAILED', error);
      }
    });
  } catch (error) {
    return compilerFailure('C#', 'CSHARP_ROSLYN_MSBUILD_PROBE_FAILED', error);
  }
}

/**
 * Runs language-native semantic analysis in a temporary, read-only helper.
 * Returned bindings are still checked by repository-analysis against the
 * original syntactic edges before any evidence can be promoted to semantic.
 */
export async function probeSystemCompilerSemantics(
  request: CompilerProbeRequest,
): Promise<CompilerProbeResult> {
  return request.language === 'Java'
    ? probeJavaCompiler(request)
    : probeCsharpCompiler(request);
}
