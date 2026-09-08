import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const requireTools = createRequire(resolve(process.env.FOREXPLORE_UI_TOOLS ?? process.cwd(), 'package.json'));
const { build } = requireTools('esbuild');
const relativePath = 'src/file-upload.ts';
const lines = (await readFile('fixtures/code-corpus/commons-fileupload-ts/' + relativePath, 'utf8')).split('\n');
const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const evidence = [
  ['parseRequest', 'implementation', 397, 426, '上传入口：请求总量与单文件大小校验。'],
  ['MultipartStream', 'dependency', 167, 195, '解析入口依赖的 multipart 流读取实现。'],
  ['FileItem', 'interface', 256, 278, '上传结果对象的读写和生命周期契约。'],
  ['SizeException', 'dependency', 34, 48, '大小限制异常，以及实际大小与阈值字段。'],
].map(([name, kind, line, end, reason]) => ({ id: name, name, kind, line, reason, path: relativePath,
  repository: 'commons-fileupload-ts', revision, content: lines.slice(line - 1, end).join('\n'),
  contentHash: createHash('sha256').update(lines.slice(line - 1, end).join('\n')).digest('hex'),
  fileHash: createHash('sha256').update(lines.join('\n')).digest('hex') }));
const stats = { modules: 3, files: 3, types: 24, methods: 68, implemented: 68, unimplemented: 0, unknown: 0, dependencies: 4 };
const target = { id: 'upload', name: '上传解析', kind: 'module', language: 'TypeScript', path: relativePath,
  signature: 'parseRequest(context: RequestContext): FileItem[]', implementationStatus: 'implemented' };
const tree = [
  { id: 'upload', name: '上传解析', kind: 'module', targetId: 'upload', purpose: '请求解析、大小校验与上传结果构建', implementationStatus: 'implemented',
    children: [{ id: relativePath, name: 'file-upload.ts', path: relativePath, kind: 'file', children: evidence.map((item) => ({ id: item.id, name: item.name, kind: item.kind === 'interface' ? 'interface' : 'method', path: item.path, line: item.line, children: [] })) }] },
  { id: 'compatibility', name: '兼容适配', kind: 'module', children: [{ id: 'compat', name: 'compatibility.ts', kind: 'file', children: [] }] },
  { id: 'public-api', name: '公开接口', kind: 'module', children: [{ id: 'index', name: 'index.ts', kind: 'file', children: [] }] },
];
const workspace = { id: 'target:fileupload', repositoryId: 'target-fileupload', projectId: 'fileupload-ts', mode: 'target',
  name: 'commons-fileupload-ts', rootLabel: '.', revision, snapshotId: revision, tree, stats,
  summary: { exists: true, path: '.forexplore/module-summary.json' },
  analysis: { state: 'ready', projection: 'ready', proposal: { summary: '文件上传实现涵盖请求解析、分段流读取、文件项管理与兼容接口。', risks: [] },
    coverage: { assigned: 3, total: 3, unassigned: [] } } };
const reference = { ...workspace, id: 'reference:fileupload', repositoryId: 'reference-fileupload', projectId: 'fileupload-java', name: 'commons-fileupload-java', mode: 'history' };
const repository = (item) => ({ repositoryId: item.repositoryId, displayName: item.name, role: item.mode, analysisStatus: 'ready', activeRevision: revision, selectedRevision: revision,
  selectedProjectId: item.projectId, revisions: [], languages: [], summary: { status: 'current' },
  projects: [{ projectId: item.projectId, displayName: item.name, relativePath: '.', kind: 'package', languageIds: ['typescript'] }] });
const payload = { target, workspaceRoot: 'commons-fileupload-ts', settings: { repositoryPaths: ['commons-fileupload-java'], topK: 4 },
  repositoryStatuses: [{ path: 'commons-fileupload-java', exists: true, readable: true }],
  codeIntelligence: { status: 'ready', storage: 'memory', repositories: [repository(workspace), repository(reference)] },
  serviceStatus: { retrieval: 'unconfigured', adaptation: 'unconfigured', executionMode: 'real' },
  moduleExplorer: { generatedAt: new Date().toISOString(), target: workspace, history: [reference] }, searchProvider: 'SeekDB', adaptationProvider: 'DeepSeek' };
const candidate = { id: 'upload-reference', title: '文件上传与大小限制', kind: 'module', language: 'Java', repository: 'commons-fileupload-java', license: 'Apache-2.0',
  path: 'org/apache/commons/fileupload/FileUploadBase.java', signature: 'List<FileItem> parseRequest(RequestContext ctx)',
  summary: '上传解析、大小限制与异常处理。', preview: '// 示例候选，源码待按版本读取。',
  score: { overall: .87, semantic: .87, symbol: .7, contract: .8 }, dependencies: ['MultipartStream', 'FileItemFactory'], compatibility: [], risks: [],
  sourceModule: { repositoryId: reference.repositoryId, analysisRevision: revision, projectId: reference.projectId, moduleId: 'upload', name: '上传解析', projectPath: '.',
    sourceFiles: ['FileUploadBase.java', 'MultipartStream.java'], coreApis: ['parseRequest'], dependsOn: [], evidenceIds: ['preview'] } };

// This bridge is bundled only into the standalone preview; the extension retains its real host.
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './apps/vscode-extension/webview/src/App';
import {formatContextMarkdown} from './packages/contracts/src/index';
import {getEncoding} from 'js-tiktoken';
import './apps/vscode-extension/webview/src/styles.css';
const payload=${JSON.stringify(payload)}, evidence=${JSON.stringify(evidence)}, candidate=${JSON.stringify(candidate)};
const send=(data)=>window.dispatchEvent(new MessageEvent('message',{data}));
window.acquireVsCodeApi=()=>({getState:()=>null,setState(){},postMessage(message){setTimeout(()=>{
  if(message.type==='READY')send({type:'INIT',payload});
  if(message.type==='START_SEARCH')send({type:'SEARCH_RESULT',candidates:[candidate]});
  if(message.type==='SELECT_WORKSPACE_TARGET')send({type:'TARGET_SELECTED',target:payload.target});
  if(message.type==='SAVE_SETTINGS')send({type:'SETTINGS_UPDATED',settings:message.settings});
  if(message.type==='COPY_TARGET_PATH')navigator.clipboard.writeText(payload.target.path);
  if(['REFRESH_REPOSITORY','REFRESH_MODULE_EXPLORER','SELECT_CODE_INTELLIGENCE_PROJECT'].includes(message.type))send({type:'MODULE_EXPLORER',explorer:payload.moduleExplorer});
},60);}});
async function search(request,signal){
 await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,450);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));},{once:true});});
 const unavailable=request.granularity==='subsystem';
 const selected=/不存在|no-match/.test(request.requirement)||unavailable?[]:evidence;
 const packet={packetId:'preview-packet',requestId:'preview-request',requirement:request.requirement,status:unavailable?'unavailable':'complete',
  snapshots:[{repositoryId:payload.moduleExplorer.target.repositoryId,analysisRevision:payload.moduleExplorer.target.revision,repositoryName:'commons-fileupload-ts',analysisHash:'preview'}],
  routing:{requestedGranularity:request.granularity,resolvedGranularities:unavailable?[]:[request.granularity==='auto'?'function':request.granularity],source:request.granularity==='auto'?'automatic':'user',reason:'交互预览示例'},
  results:[],relations:[],gaps:unavailable?[{code:'GRANULARITY_UNAVAILABLE',message:'此预览未建立子系统索引。'}]:[],
  evidence:selected.map(item=>({evidenceId:item.id,role:item.kind,name:item.name,repositoryId:payload.moduleExplorer.target.repositoryId,analysisRevision:item.revision,relativePath:item.path,
    sourceRange:{startLine:item.line,startColumn:1,endLine:item.line+item.content.split('\\n').length,endColumn:1},contentHash:item.contentHash,fileHash:item.fileHash,content:item.content,reason:item.reason,provider:'tree-sitter',evidenceLevel:'structural',truncated:false})),
  markdown:'',usage:{tokenizer:'cl100k_base',tokens:0,maxTokens:4000,characters:0,files:0,sourceLines:0,latencyMs:450}};
 const encoding=getEncoding('cl100k_base');
 do {packet.markdown=formatContextMarkdown(packet);packet.usage.tokens=encoding.encode(packet.markdown).length;
  if(packet.usage.tokens<=packet.usage.maxTokens||!packet.evidence.length)break;
  packet.evidence.pop();packet.status='partial';
 } while(true);
 packet.usage.characters=packet.markdown.length;packet.usage.files=packet.evidence.length?1:0;
 packet.usage.sourceLines=packet.evidence.reduce((sum,item)=>sum+item.content.split('\\n').length,0);
 return packet;
}
createRoot(document.getElementById('root')).render(<><div className="preview-banner">交互预览 · 示例数据 <span>FileUpload 源码片段</span></div><App taskSearch={search}/></>);`;
const output = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false,
  outfile: 'workbench.js', format: 'iife', platform: 'browser', jsx: 'automatic', minify: true, define: { 'process.env.NODE_ENV': '"production"' } });
const css = output.outputFiles.find((file) => file.path.endsWith('.css')).text;
const js = output.outputFiles.find((file) => file.path.endsWith('.js')).text;
await mkdir('logs', { recursive: true });
const preview = resolve('logs/workbench-preview.html');
await writeFile(preview, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ForeXplore 工作台预览</title><style>${css}
.preview-banner{height:26px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;color:#c9b66d;background:#302d22;font-size:10px;border-bottom:1px solid #484330}.preview-banner span{color:#a39b80}#root>.app{height:calc(100% - 26px)}
</style><body><div id="root"></div><script>${js.replaceAll('</script', '<\\/script')}</script></body></html>`);
console.log(preview);
