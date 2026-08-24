import React, { useState, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';

function editorExtensions(language: string) {
  switch (language) {
    case 'typescript':
      return [javascript({ typescript: true, jsx: true })];
    case 'javascript':
      return [javascript({ jsx: true })];
    case 'python':
      return [python()];
    case 'json':
      return [json()];
    case 'html':
      return [html()];
    default:
      return [];
  }
}
import { 
  FileCode, 
  Folder, 
  Play, 
  Terminal, 
  Globe, 
  CheckCircle2, 
  AlertCircle, 
  Sparkles, 
  Save, 
  RotateCcw, 
  ShieldCheck, 
  Layers,
  Code2,
  RefreshCw,
  Eye,
  Plus,
  Upload,
  FolderTree,
  HardDrive,
  Trash2,
  FileDiff,
  Undo2
} from 'lucide-react';
import { WorkspaceFile, LSPDiagnostic } from '../types';
import { DiffView } from './DiffView';

interface CodeWorkspaceProps {
  files: Record<string, WorkspaceFile>;
  activeFilePath: string;
  onSelectFile: (path: string) => void;
  onSaveFile: (path: string, content: string, imported?: boolean) => void;
  onDeleteFile?: (path: string) => void;
  onClearWorkspace?: () => void;
  onResetWorkspace?: () => void;
  onRefreshWorkspace?: () => void;
  onLoadDirectoryPath?: (path: string) => Promise<{ 
    success: boolean; 
    fileCount?: number; 
    activeDirectory?: string; 
    isLocalMachinePath?: boolean;
    message?: string;
    error?: string;
  }>;
  diagnostics: LSPDiagnostic[];
  onExecuteCommand: (cmd: string) => void;
  commandOutput: string;
  isExecuting: boolean;
  sessionId?: string;
  targetFolderPath: string;
  onTargetFolderPathChange: (v: string) => void;
}

export const CodeWorkspace: React.FC<CodeWorkspaceProps> = ({
  files,
  activeFilePath,
  onSelectFile,
  onSaveFile,
  onDeleteFile,
  onClearWorkspace,
  onResetWorkspace,
  onRefreshWorkspace,
  onLoadDirectoryPath,
  diagnostics,
  onExecuteCommand,
  commandOutput,
  isExecuting,
  sessionId = 'default',
  targetFolderPath,
  onTargetFolderPathChange
}) => {
  const activeFile = files[activeFilePath] || Object.values(files)[0];
  const [editorContent, setEditorContent] = useState(activeFile ? activeFile.content : '');
  const [viewMode, setViewMode] = useState<'editor' | 'terminal' | 'preview' | 'diff'>('editor');
  const [fileDiffModal, setFileDiffModal] = useState<{ filePath: string; patch: string; additions: number; deletions: number } | null>(null);
  const [isReverting, setIsReverting] = useState<string | null>(null);
  const [isLoadingDirectory, setIsLoadingDirectory] = useState(false);
  const [statusNotification, setStatusNotification] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState('');
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (activeFile) {
      setEditorContent(activeFile.content);
    }
  }, [activeFilePath, activeFile]);

  const fileKeys = Object.keys(files);
  const fileDiagnostics = diagnostics.filter(d => activeFile && d.filePath === activeFile.path);

  // U5: per-file diff / revert against latest backup snapshot
  const handleShowFileDiff = async (path: string) => {
    try {
      const res = await fetch(`/api/workspace/file-diff?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (data.hasChanges) {
        setFileDiffModal(data);
      } else {
        setStatusNotification(`No agent changes recorded for ${path}`);
        setTimeout(() => setStatusNotification(null), 3000);
      }
    } catch {
      setStatusNotification('Failed to compute diff');
      setTimeout(() => setStatusNotification(null), 3000);
    }
  };

  const handleRevertFile = async (path: string) => {
    if (!window.confirm(`Revert ${path} to the last pre-agent-edit snapshot?`)) return;
    setIsReverting(path);
    try {
      const res = await fetch('/api/workspace/revert-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, path })
      });
      const data = await res.json();
      if (data.success) {
        if (path === activeFilePath) setEditorContent(data.content);
        setStatusNotification(`Reverted ${path} (from ${data.backupName})`);
        onRefreshWorkspace?.();
      } else {
        setStatusNotification(data.error || 'No snapshot found for this file');
      }
    } catch {
      setStatusNotification('Revert failed');
    } finally {
      setIsReverting(null);
      setTimeout(() => setStatusNotification(null), 4000);
    }
  };

  const handleTriggerLoadDirectory = async () => {
    // Strip whitespace and surrounding quotes (Windows "Copy as Path" adds them)
    const cleanedPath = targetFolderPath.trim().replace(/^["']+|["']+$/g, '').trim();
    if (!cleanedPath) {
      // Nothing typed: fall back to the native folder picker
      setStatusNotification('💡 No path typed — opening folder picker. Select a folder to import it.');
      setTimeout(() => {
        fileInputRef.current?.click();
      }, 300);
      return;
    }
    if (cleanedPath !== targetFolderPath) {
      onTargetFolderPathChange(cleanedPath);
    }
    setIsLoadingDirectory(true);
    setStatusNotification(`Scanning directory path: "${cleanedPath}"...`);

    if (onLoadDirectoryPath) {
      const res = await onLoadDirectoryPath(cleanedPath);
      if (res.success) {
        const loadedDir = res.activeDirectory || cleanedPath;
        setStatusNotification(`📁 Active Working Folder Loaded: "${loadedDir}" (${res.fileCount} code files scanned and active)`);
      } else if (res.isLocalMachinePath) {
        setStatusNotification(`💡 Path "${cleanedPath}" is on your local PC disk. Opening folder picker... Select the folder to read all files directly!`);
        setTimeout(() => {
          fileInputRef.current?.click();
        }, 300);
      } else {
        setStatusNotification(`❌ Error loading folder: ${res.error || 'Unable to scan directory path'}`);
      }
    }
    setIsLoadingDirectory(false);
  };

  const handleSave = () => {
    if (activeFile) {
      onSaveFile(activeFile.path, editorContent);
    }
  };

  const handleCreateFile = () => {
    if (!newFileName.trim()) return;
    const path = newFileName.trim();
    const ext = path.split('.').pop()?.toLowerCase() || 'txt';
    let lang = 'plaintext';
    if (ext === 'py') lang = 'python';
    else if (ext === 'ts' || ext === 'tsx') lang = 'typescript';
    else if (ext === 'js' || ext === 'jsx') lang = 'javascript';
    else if (ext === 'json') lang = 'json';
    else if (ext === 'ipynb') lang = 'python';
    else if (ext === 'md') lang = 'markdown';
    else if (ext === 'yaml' || ext === 'yml') lang = 'yaml';

    onSaveFile(path, `# ${path}\n// New file created in workspace`);
    onSelectFile(path);
    setNewFileName('');
    setIsCreatingFile(false);
  };

  const handleFolderUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = e.target.files;
    if (!uploadedFiles || uploadedFiles.length === 0) return;

    const fileList = Array.from(uploadedFiles) as Array<File & { webkitRelativePath?: string }>;
    const firstRelPath = fileList[0]?.webkitRelativePath || '';
    const rootFolderName = firstRelPath.split('/')[0] || targetFolderPath || 'Selected Folder';

    if (rootFolderName) {
      onTargetFolderPathChange(rootFolderName);
    }

    let loadedCount = 0;
    fileList.forEach((file) => {
      const relPath = file.webkitRelativePath || file.name;
      // Skip node_modules, .git, dist, build
      if (relPath.includes('/node_modules/') || relPath.includes('/.git/') || relPath.includes('/dist/') || relPath.includes('/build/')) {
        return;
      }

      const reader = new FileReader();
      const ext = relPath.split('.').pop()?.toLowerCase() || '';
      
      reader.onload = (event) => {
        const content = event.target?.result as string || '';
        onSaveFile(relPath, content, true);
        loadedCount++;
        if (loadedCount === 1) {
          onSelectFile(relPath);
        }
        setStatusNotification(`📁 Imported "${rootFolderName}" (${fileList.length} files) — agent works on a real on-disk copy. For live editing of the original, use Load Folder with its full path.`);
      };
      
      if (['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg', 'ico', 'webp'].includes(ext)) {
        reader.readAsDataURL(file);
      } else {
        reader.readAsText(file);
      }
    });
  };

  return (
    <div className="flex flex-col h-[calc(100vh-140px)] bg-slate-950 rounded-xl border border-slate-800 overflow-hidden shadow-2xl">
      {/* Root Directory Target Selector Bar */}
      <div className="bg-slate-900/90 border-b border-slate-800 px-3.5 py-2 flex flex-wrap items-center justify-between gap-2.5 text-xs">
        <div className="flex items-center space-x-2 flex-1 min-w-[320px]">
          <HardDrive className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="font-semibold text-slate-300 text-xs shrink-0">Target Directory Path:</span>
          <div className="flex items-center flex-1 bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1 text-slate-200 font-mono focus-within:border-emerald-500 shadow-inner">
            <span className="text-slate-500 mr-1.5 select-none">📁</span>
            <input
              type="text"
              value={targetFolderPath}
              onChange={(e) => onTargetFolderPathChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleTriggerLoadDirectory();
                }
              }}
              placeholder="Paste directory path (e.g. C:\Users\Desktop\MyProject or /workspace/app) and press Enter"
              className="w-full bg-transparent border-none outline-none text-xs text-emerald-300 font-mono"
            />
            <button
              type="button"
              onClick={handleTriggerLoadDirectory}
              disabled={isLoadingDirectory}
              className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 text-white font-mono text-[11px] font-semibold flex items-center gap-1 transition-all ml-1.5 shrink-0 shadow-sm"
              title="Press Enter or click to scan and load directory as active workspace"
            >
              {isLoadingDirectory ? (
                <RefreshCw className="w-3 h-3 animate-spin text-emerald-200" />
              ) : (
                <FolderTree className="w-3.5 h-3.5 text-white" />
              )}
              <span>{isLoadingDirectory ? 'Reading...' : 'Load Folder (Enter)'}</span>
            </button>
          </div>
        </div>

        <div className="flex items-center space-x-2 shrink-0">
          {onRefreshWorkspace && (
            <button
              onClick={onRefreshWorkspace}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-400 border border-slate-700 text-xs font-medium flex items-center gap-1.5 transition-all"
              title="Re-scan and refresh local workspace files"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh Workspace</span>
            </button>
          )}

          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFolderUpload}
            multiple
            {...({ webkitdirectory: "", directory: "" } as any)}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium flex items-center gap-1.5 transition-all"
            title="Import a folder or files from your local computer into the workspace"
          >
            <Upload className="w-3.5 h-3.5 text-cyan-400" />
            <span>Import Folder / Files</span>
          </button>

          <button
            onClick={() => setIsCreatingFile(!isCreatingFile)}
            className="px-2.5 py-1.5 rounded-lg bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 border border-emerald-500/40 text-xs font-semibold flex items-center gap-1.5 transition-all"
          >
            <Plus className="w-3.5 h-3.5 text-emerald-400" />
            <span>New File</span>
          </button>
        </div>
      </div>

      {statusNotification && (
        <div className="bg-emerald-950/80 border-b border-emerald-800/80 px-4 py-2 flex items-center justify-between text-xs text-emerald-200 animate-fadeIn font-mono">
          <div className="flex items-center gap-2 truncate">
            <Sparkles className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="truncate">{statusNotification}</span>
          </div>
          <button
            type="button"
            onClick={() => setStatusNotification(null)}
            className="text-emerald-400 hover:text-white text-[11px] font-semibold ml-2 shrink-0 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {isCreatingFile && (
        <div className="bg-slate-900 border-b border-slate-800 px-4 py-2 flex items-center space-x-2 animate-fadeIn">
          <span className="text-xs text-slate-400 font-mono">Relative File Path:</span>
          <input
            type="text"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            placeholder="e.g., notebooks/analysis.ipynb or src/utils.py"
            className="flex-1 bg-slate-950 border border-slate-800 rounded-md px-3 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-emerald-500"
            onKeyDown={(e) => e.key === 'Enter' && handleCreateFile()}
          />
          <button
            onClick={handleCreateFile}
            className="px-3 py-1 rounded bg-emerald-600 text-white font-medium text-xs hover:bg-emerald-500"
          >
            Create
          </button>
          <button
            onClick={() => setIsCreatingFile(false)}
            className="px-2 py-1 text-xs text-slate-400 hover:text-white"
          >
            Cancel
          </button>
        </div>
      )}

      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* File Tree Sidebar */}
        <div className="w-full lg:w-64 bg-slate-900 border-b lg:border-b-0 lg:border-r border-slate-800 flex flex-col shrink-0">
          <div className="p-3 border-b border-slate-800 flex items-center justify-between">
            <span className="font-bold text-xs text-white flex items-center gap-1.5 uppercase tracking-wider">
              <Folder className="w-4 h-4 text-emerald-400" /> Workspace Files
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
              {fileKeys.length} files
            </span>
          </div>

          {/* Active Folder Indicator Badge */}
          <div className="px-3 py-1.5 bg-slate-950/90 border-b border-slate-800 flex items-center justify-between text-[11px] font-mono">
            <div className="flex items-center gap-1.5 truncate text-slate-300">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0"></span>
              <span className="text-slate-400 shrink-0">Active Dir:</span>
              <span className="text-emerald-300 font-semibold truncate" title={targetFolderPath}>
                {targetFolderPath || 'No folder loaded'}
              </span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {fileKeys.length === 0 ? (
              <div className="p-4 text-center text-slate-500 text-xs">
                Workspace is empty.
                <button
                  onClick={onResetWorkspace}
                  className="block mx-auto mt-2 text-emerald-400 hover:underline text-[11px]"
                >
                  Restore default files
                </button>
              </div>
            ) : (
              fileKeys.map((pathKey) => {
                const file = files[pathKey];
                const isSelected = file.path === activeFilePath;
                const hasError = diagnostics.some(d => d.filePath === file.path && d.severity === 'error');

                return (
                  <div
                    key={file.path}
                    className={`group w-full px-2.5 py-1.5 rounded-lg text-xs font-mono flex items-center justify-between transition-all ${
                      isSelected
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold'
                        : 'text-slate-300 hover:bg-slate-800/60'
                    }`}
                  >
                    <button
                      onClick={() => {
                        onSelectFile(file.path);
                        setEditorContent(file.content);
                      }}
                      className="flex items-center gap-2 truncate flex-1 text-left"
                    >
                      <FileCode className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-emerald-400' : 'text-slate-400'}`} />
                      <span className="truncate">{file.path}</span>
                    </button>

                    <div className="flex items-center space-x-1 shrink-0 ml-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleShowFileDiff(file.path);
                        }}
                        title="View diff vs last agent edit"
                        className="p-1 rounded text-slate-500 hover:text-cyan-400 hover:bg-slate-800 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <FileDiff className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRevertFile(file.path);
                        }}
                        disabled={isReverting === file.path}
                        title="Revert to last pre-agent-edit snapshot"
                        className="p-1 rounded text-slate-500 hover:text-amber-400 hover:bg-slate-800 transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-40"
                      >
                        <Undo2 className={`w-3.5 h-3.5 ${isReverting === file.path ? 'animate-pulse' : ''}`} />
                      </button>
                      {hasError && (
                        <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                      )}
                      {onDeleteFile && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm(`Delete ${file.path}?`)) {
                              onDeleteFile(file.path);
                            }
                          }}
                          className="p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-slate-800 transition-colors opacity-0 group-hover:opacity-100"
                          title="Delete File"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Workspace Reset & Clear Controls */}
          <div className="px-2.5 py-2 border-t border-slate-800/80 bg-slate-900/50 flex items-center justify-between text-[11px]">
            {onResetWorkspace && (
              <button
                onClick={onResetWorkspace}
                className="text-slate-400 hover:text-emerald-300 flex items-center gap-1 transition-colors"
                title="Restore default workspace template files"
              >
                <RotateCcw className="w-3 h-3 text-emerald-400" /> Restore Defaults
              </button>
            )}
            {onClearWorkspace && (
              <button
                onClick={() => {
                  if (window.confirm("Are you sure you want to delete ALL files in this workspace?")) {
                    onClearWorkspace();
                  }
                }}
                className="text-slate-400 hover:text-rose-400 flex items-center gap-1 transition-colors"
                title="Delete all workspace files"
              >
                <Trash2 className="w-3 h-3 text-rose-400" /> Clear All
              </button>
            )}
          </div>

          {/* Quick Command Execution Bar */}
          <div className="p-2.5 border-t border-slate-800 bg-slate-950 space-y-1.5">
            <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold block mb-1">
              Sandbox Commands
            </span>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                onClick={() => {
                  setViewMode('terminal');
                  onExecuteCommand('npm start');
                }}
                className="px-2.5 py-1.5 rounded-lg bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 border border-emerald-500/40 text-[11px] font-mono flex items-center justify-center gap-1 font-semibold transition-all"
              >
                <Play className="w-3 h-3 text-emerald-400" /> npm start
              </button>
              <button
                onClick={() => {
                  setViewMode('terminal');
                  onExecuteCommand('npm test');
                }}
                className="px-2.5 py-1.5 rounded-lg bg-cyan-600/30 hover:bg-cyan-600/50 text-cyan-300 border border-cyan-500/40 text-[11px] font-mono flex items-center justify-center gap-1 font-semibold transition-all"
              >
                <Terminal className="w-3 h-3 text-cyan-400" /> vitest run
              </button>
            </div>
          </div>
        </div>

      {/* Main Code Editor & Preview View */}
      <div className="flex-1 flex flex-col bg-slate-950 overflow-hidden">
        {/* Editor Top Bar & Tabs */}
        <div className="bg-slate-900 border-b border-slate-800 px-4 py-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center space-x-2 font-mono text-xs text-slate-200">
            <FileCode className="w-4 h-4 text-emerald-400" />
            <span className="font-bold text-white">{activeFile ? activeFile.path : 'src/index.ts'}</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 uppercase">
              {activeFile ? activeFile.language : 'typescript'}
            </span>
          </div>

          <div className="flex items-center space-x-2">
            {/* View Switcher */}
            <div className="flex items-center bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
              <button
                onClick={() => setViewMode('editor')}
                className={`px-2.5 py-1 rounded-md transition-all ${
                  viewMode === 'editor'
                    ? 'bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Code Editor
              </button>
              <button
                onClick={() => setViewMode('terminal')}
                className={`px-2.5 py-1 rounded-md transition-all flex items-center gap-1 ${
                  viewMode === 'terminal'
                    ? 'bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Terminal className="w-3 h-3" /> Terminal
              </button>
              <button
                onClick={() => setViewMode('preview')}
                className={`px-2.5 py-1 rounded-md transition-all flex items-center gap-1 ${
                  viewMode === 'preview'
                    ? 'bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Globe className="w-3 h-3" /> API Preview
              </button>
            </div>

            {/* Save Button */}
            <button
              onClick={handleSave}
              className="flex items-center space-x-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs shadow-md transition-all"
            >
              <Save className="w-3.5 h-3.5" />
              <span>Save</span>
            </button>
          </div>
        </div>

        {/* View Modes */}
        {viewMode === 'editor' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-hidden [&_.cm-editor]:h-full [&_.cm-scroller]:font-mono [&_.cm-gutters]:bg-slate-950 [&_.cm-gutters]:border-slate-800">
              <CodeMirror
                value={editorContent}
                height="100%"
                theme={oneDark}
                extensions={editorExtensions(activeFile?.language || 'plaintext')}
                onChange={(value) => setEditorContent(value)}
                basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: true }}
              />
            </div>

            {/* File Diagnostics Footer */}
            {fileDiagnostics.length > 0 && (
              <div className="bg-slate-900 border-t border-slate-800 p-2.5 px-4 text-xs">
                <span className="font-semibold text-amber-400 flex items-center gap-1 mb-1">
                  <AlertCircle className="w-3.5 h-3.5 text-amber-400" /> LSP Diagnostics for this file ({fileDiagnostics.length}):
                </span>
                <div className="space-y-1 max-h-24 overflow-y-auto font-mono text-[11px] text-slate-300">
                  {fileDiagnostics.map((d, idx) => (
                    <div key={idx} className="flex items-center space-x-2">
                      <span className="text-amber-400">Line {d.line}:{d.column}</span>
                      <span>[{d.code}]</span>
                      <span className="text-slate-200">{d.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {viewMode === 'terminal' && (
          <div className="flex-1 p-4 bg-slate-950 font-mono text-xs text-slate-200 overflow-y-auto">
            <div className="flex items-center justify-between pb-2 mb-3 border-b border-slate-800">
              <span className="text-emerald-400 font-bold flex items-center gap-1.5">
                <Terminal className="w-4 h-4 text-cyan-400" /> Isolated Container Sandbox Terminal
              </span>
              {isExecuting && (
                <span className="flex items-center gap-1 text-cyan-400 animate-pulse text-[11px]">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Running Command...
                </span>
              )}
            </div>
            <pre className="whitespace-pre-wrap leading-relaxed text-slate-300">
              {commandOutput || `$ echo "OpenCode Sandbox Ready. Run 'npm start' or 'vitest run'."`}
            </pre>
          </div>
        )}

        {viewMode === 'preview' && (
          <div className="flex-1 p-6 bg-slate-950 text-slate-100 flex flex-col items-center justify-center">
            <div className="max-w-xl w-full bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-xl text-center">
              <div className="w-12 h-12 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto mb-3 border border-emerald-500/30">
                <Globe className="w-6 h-6" />
              </div>
              <h4 className="font-bold text-base text-white mb-1">Interactive OpenCode API Endpoint Preview</h4>
              <p className="text-xs text-slate-400 mb-4">
                Simulated response for <code>GET http://localhost:3000/api/tasks</code>
              </p>

              <div className="text-left bg-slate-950 p-4 rounded-xl border border-slate-800 font-mono text-xs text-emerald-300 overflow-x-auto">
                <pre>{`{
  "status": "ok",
  "tasks": [
    { "id": "1", "title": "Initialize LangGraph Agent Pipeline", "completed": true, "priority": "high" },
    { "id": "2", "title": "Load Language Server Protocol (LSP)", "completed": true, "priority": "high" },
    { "id": "3", "title": "Setup Multi-Session Agent Workspace", "completed": false, "priority": "medium" }
  ],
  "metrics": {
    "total": 3,
    "completedCount": 2,
    "pendingCount": 1,
    "completionRate": "66.7%"
  }
}`}</pre>
              </div>
            </div>
          </div>
        )}

        {/* U5: file diff modal */}
        {fileDiffModal && (
          <div
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setFileDiffModal(null)}
          >
            <div
              className="bg-slate-900 border border-slate-800 rounded-2xl max-w-3xl w-full max-h-[85vh] overflow-y-auto p-5 text-slate-100"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-bold text-sm flex items-center gap-2">
                  <FileDiff className="w-4 h-4 text-cyan-400" />
                  Diff: {fileDiffModal.filePath}
                </h4>
                <button onClick={() => setFileDiffModal(null)} className="text-slate-400 hover:text-white text-xs px-2 py-1 rounded hover:bg-slate-800">Close</button>
              </div>
              <DiffView patches={[fileDiffModal]} />
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => {
                    handleRevertFile(fileDiffModal.filePath);
                    setFileDiffModal(null);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-amber-600/80 hover:bg-amber-500 text-white text-xs font-semibold"
                >
                  Revert this file
                </button>
                <button onClick={() => setFileDiffModal(null)} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium">Keep changes</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  </div>
  );
};
