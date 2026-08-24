import React, { useState } from 'react';
import { 
  ShieldCheck, 
  AlertTriangle, 
  AlertCircle, 
  Info, 
  CheckCircle2, 
  Wrench, 
  RefreshCw, 
  FileCode, 
  Cpu,
  Search,
  Zap,
  Terminal
} from 'lucide-react';
import { LSPDiagnostic, LSPServerStatus } from '../types';

interface LspPanelProps {
  servers: LSPServerStatus[];
  diagnostics: LSPDiagnostic[];
  onScanDiagnostics: () => void;
  onFixWithAgent: (diagnostic: LSPDiagnostic) => void;
}

export const LspPanel: React.FC<LspPanelProps> = ({
  servers,
  diagnostics,
  onScanDiagnostics,
  onFixWithAgent
}) => {
  const [filterSeverity, setFilterSeverity] = useState<'all' | 'error' | 'warning' | 'info'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredDiagnostics = diagnostics.filter(d => {
    if (filterSeverity !== 'all' && d.severity !== filterSeverity) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        d.message.toLowerCase().includes(q) ||
        d.filePath.toLowerCase().includes(q) ||
        d.code.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const errorCount = diagnostics.filter(d => d.severity === 'error').length;
  const warningCount = diagnostics.filter(d => d.severity === 'warning').length;
  const infoCount = diagnostics.filter(d => d.severity === 'info').length;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-xl text-slate-100">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between pb-4 mb-4 border-b border-slate-800 gap-3">
        <div>
          <h3 className="font-bold text-lg flex items-center gap-2 text-white">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            Language Server Protocol (LSP) Engine
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Automated language server integration feeding real-time type & syntax diagnostics directly into the LLM context.
          </p>
        </div>

        <button
          onClick={onScanDiagnostics}
          className="flex items-center space-x-2 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs shadow-md transition-all"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Run Full LSP Scan</span>
        </button>
      </div>

      {/* Language Servers Status Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        {servers.map((server) => (
          <div key={server.id} className="bg-slate-950 p-3 rounded-xl border border-slate-800/80">
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-bold text-xs text-slate-200 truncate">{server.language}</span>
              <span className="flex items-center text-[10px] text-emerald-400 font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1 animate-pulse" />
                {server.status}
              </span>
            </div>
            <div className="text-[11px] text-slate-400 font-mono mb-2">{server.name}</div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono border-t border-slate-800/80 pt-1.5">
              <span>{server.version}</span>
              <span className="text-slate-300">{server.extensions.join(', ')}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Diagnostics Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4 bg-slate-950 p-3 rounded-xl border border-slate-800">
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setFilterSeverity('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              filterSeverity === 'all'
                ? 'bg-slate-800 text-white border border-slate-700'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            All ({diagnostics.length})
          </button>
          <button
            onClick={() => setFilterSeverity('error')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1 transition-all ${
              filterSeverity === 'error'
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                : 'text-slate-400 hover:text-rose-400'
            }`}
          >
            <AlertCircle className="w-3.5 h-3.5 text-rose-400" />
            <span>Errors ({errorCount})</span>
          </button>
          <button
            onClick={() => setFilterSeverity('warning')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1 transition-all ${
              filterSeverity === 'warning'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                : 'text-slate-400 hover:text-amber-400'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            <span>Warnings ({warningCount})</span>
          </button>
          <button
            onClick={() => setFilterSeverity('info')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1 transition-all ${
              filterSeverity === 'info'
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                : 'text-slate-400 hover:text-cyan-400'
            }`}
          >
            <Info className="w-3.5 h-3.5 text-cyan-400" />
            <span>Info ({infoCount})</span>
          </button>
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search diagnostic code or file..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 pr-3 py-1.5 bg-slate-900 border border-slate-700/80 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
          />
        </div>
      </div>

      {/* Diagnostic Items Table */}
      {filteredDiagnostics.length === 0 ? (
        <div className="p-8 text-center bg-slate-950/60 rounded-xl border border-slate-800 my-2">
          <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto mb-2 opacity-80" />
          <h4 className="font-semibold text-sm text-slate-200">Zero Diagnostic Errors Found</h4>
          <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
            Your workspace language server diagnostics report 100% clean type compliance. No syntax or import blockers detected.
          </p>
        </div>
      ) : (
        <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
          {filteredDiagnostics.map((diag) => (
            <div
              key={diag.id}
              className={`p-3 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-all ${
                diag.severity === 'error'
                  ? 'bg-rose-950/20 border-rose-900/60'
                  : diag.severity === 'warning'
                  ? 'bg-amber-950/20 border-amber-900/60'
                  : 'bg-slate-950 border-slate-800'
              }`}
            >
              <div className="flex items-start space-x-3">
                <div className="mt-0.5">
                  {diag.severity === 'error' ? (
                    <AlertCircle className="w-4 h-4 text-rose-400" />
                  ) : diag.severity === 'warning' ? (
                    <AlertTriangle className="w-4 h-4 text-amber-400" />
                  ) : (
                    <Info className="w-4 h-4 text-cyan-400" />
                  )}
                </div>

                <div>
                  <div className="flex items-center space-x-2">
                    <span className="font-mono text-xs font-bold text-slate-200 flex items-center gap-1">
                      <FileCode className="w-3.5 h-3.5 text-slate-400" />
                      {diag.filePath}:{diag.line}:{diag.column}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 font-mono border border-slate-700">
                      {diag.code}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono">({diag.source})</span>
                  </div>

                  <p className="text-xs text-slate-300 mt-1">{diag.message}</p>

                  {diag.suggestedFix && (
                    <div className="mt-1.5 p-1.5 rounded bg-slate-900/90 border border-slate-800 font-mono text-[11px] text-emerald-300">
                      Suggested Fix: <code>{diag.suggestedFix}</code>
                    </div>
                  )}
                </div>
              </div>

              <button
                onClick={() => onFixWithAgent(diag)}
                className="self-start sm:self-center flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-cyan-600/30 hover:bg-cyan-600/50 text-cyan-300 border border-cyan-500/40 text-xs font-semibold transition-all whitespace-nowrap"
              >
                <Zap className="w-3.5 h-3.5 text-cyan-300" />
                <span>Auto-Fix via Agent</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
