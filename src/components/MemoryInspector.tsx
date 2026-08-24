import React, { useState } from 'react';
import { 
  Brain, 
  Clock, 
  Database, 
  FileCode, 
  FolderTree, 
  Plus, 
  Trash2, 
  Sparkles, 
  Eye, 
  Activity, 
  Terminal, 
  Bookmark, 
  Filter, 
  CheckCircle2, 
  Layers,
  Cpu
} from 'lucide-react';
import { LongTermMemoryItem, ShortTermMemoryState } from '../types';

interface MemoryInspectorProps {
  longTermMemories: LongTermMemoryItem[];
  shortTermMemory: ShortTermMemoryState;
  onAddMemory: (key: string, value: string, category: LongTermMemoryItem['category']) => void;
  onDeleteMemory: (id: string) => void;
  onClearAllMemories: () => void;
  onAutoExtractMemories?: () => void;
  promptContextPreview?: string;
  activeFilePath?: string;
}

export const MemoryInspector: React.FC<MemoryInspectorProps> = ({
  longTermMemories,
  shortTermMemory,
  onAddMemory,
  onDeleteMemory,
  onClearAllMemories,
  onAutoExtractMemories,
  promptContextPreview,
  activeFilePath
}) => {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newCategory, setNewCategory] = useState<LongTermMemoryItem['category']>('convention');
  const [selectedFilter, setSelectedFilter] = useState<string>('all');
  const [showPromptPreview, setShowPromptPreview] = useState(false);

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKey.trim() || !newValue.trim()) return;
    onAddMemory(newKey.trim(), newValue.trim(), newCategory);
    setNewKey('');
    setNewValue('');
  };

  const filteredMemories = longTermMemories.filter((m) => {
    if (selectedFilter === 'all') return true;
    return m.category === selectedFilter;
  });

  const getCategoryBadgeClass = (category: LongTermMemoryItem['category']) => {
    switch (category) {
      case 'convention':
        return 'bg-purple-500/20 text-purple-300 border-purple-500/30';
      case 'architecture':
        return 'bg-blue-500/20 text-blue-300 border-blue-500/30';
      case 'bug_note':
        return 'bg-rose-500/20 text-rose-300 border-rose-500/30';
      case 'preference':
        return 'bg-amber-500/20 text-amber-300 border-amber-500/30';
      default:
        return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30';
    }
  };

  return (
    <div className="h-full flex flex-col bg-slate-950 text-slate-100 overflow-y-auto p-4 lg:p-6 space-y-6">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 p-5 rounded-2xl border border-slate-800 shadow-xl">
        <div className="flex items-center space-x-3">
          <div className="p-3 bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded-xl shadow-inner">
            <Brain className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <h2 className="font-bold text-lg text-white flex items-center gap-2">
              Memory & Context Intelligence Engine
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Dual-tier cognitive architecture: Cross-session Long-Term Memory (LTM) + Active Working Short-Term Memory (STM).
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowPromptPreview(!showPromptPreview)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium font-mono flex items-center gap-1.5 border transition-all ${
              showPromptPreview
                ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/50 shadow-md'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
            }`}
          >
            <Eye className="w-3.5 h-3.5 text-cyan-400" />
            <span>{showPromptPreview ? 'Hide Raw Context' : 'Inspect AI Context Payload'}</span>
          </button>

          {onAutoExtractMemories && (
            <button
              onClick={onAutoExtractMemories}
              className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-mono text-xs font-semibold flex items-center gap-1.5 transition-all shadow-md"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Auto-Extract Project Facts</span>
            </button>
          )}
        </div>
      </div>

      {/* Raw Context Preview Modal / Box */}
      {showPromptPreview && (
        <div className="bg-slate-900 border border-cyan-500/40 rounded-xl p-4 space-y-2 animate-fadeIn shadow-2xl">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono font-bold text-cyan-300 flex items-center gap-1.5">
              <Cpu className="w-4 h-4 text-cyan-400" />
              Live AI System Instruction & Workspace Context Payload
            </span>
            <span className="text-[10px] bg-slate-800 px-2 py-0.5 rounded text-slate-400 font-mono">
              Injected into the local Ollama model on every prompt
            </span>
          </div>
          <pre className="text-[11px] font-mono text-slate-300 bg-slate-950 p-3 rounded-lg border border-slate-800 max-h-60 overflow-y-auto whitespace-pre-wrap leading-relaxed">
            {promptContextPreview || 'Compiling memory context payload...'}
          </pre>
        </div>
      )}

      {/* Grid Layout: Short-Term Memory & Long-Term Memory */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Short-Term Working Memory (STM) */}
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-lg space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="font-bold text-sm text-white flex items-center gap-2">
                <Clock className="w-4 h-4 text-cyan-400" />
                Short-Term Memory (STM)
              </h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-mono">
                Working State
              </span>
            </div>

            <div className="space-y-3 text-xs">
              {/* Active Workspace Focus */}
              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-1">
                <div className="text-[11px] text-slate-400 font-medium flex items-center gap-1.5">
                  <FileCode className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Active Open File Focus</span>
                </div>
                <div className="font-mono text-emerald-300 font-semibold truncate">
                  {activeFilePath || shortTermMemory.activeFilePath || 'None selected (Root workspace)'}
                </div>
              </div>

              {/* Working Directory */}
              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-1">
                <div className="text-[11px] text-slate-400 font-medium flex items-center gap-1.5">
                  <FolderTree className="w-3.5 h-3.5 text-amber-400" />
                  <span>Loaded Project Workspace</span>
                </div>
                <div className="font-mono text-slate-200 truncate">
                  {shortTermMemory.activeDirectoryPath || 'Default Workspace'}
                </div>
                <div className="text-[10px] text-slate-400 font-mono pt-0.5">
                  Total files scanned: <span className="text-white font-semibold">{shortTermMemory.totalWorkspaceFiles}</span>
                </div>
              </div>

              {/* Chat Session Objective */}
              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-1">
                <div className="text-[11px] text-slate-400 font-medium flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Current Task Objective</span>
                </div>
                <div className="text-slate-200">
                  {shortTermMemory.currentObjective || 'Autonomous Agent Chat Active'}
                </div>
                <div className="text-[10px] text-slate-400 font-mono pt-0.5 flex justify-between">
                  <span>Chat Turns Memory:</span>
                  <span className="text-cyan-300 font-semibold">{shortTermMemory.turnCount} turns windowed</span>
                </div>
              </div>

              {/* Diagnostic Error Monitor */}
              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-slate-300">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Active LSP Error Count</span>
                </div>
                <span className={`font-mono text-xs font-bold px-2 py-0.5 rounded ${
                  shortTermMemory.activeDiagnosticErrorsCount > 0
                    ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                    : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                }`}>
                  {shortTermMemory.activeDiagnosticErrorsCount} issues
                </span>
              </div>

              {/* Terminal Execution Memory */}
              {shortTermMemory.lastExecutedCommand && (
                <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-1">
                  <div className="text-[11px] text-slate-400 font-medium flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Last Terminal Command</span>
                  </div>
                  <div className="font-mono text-xs text-cyan-300 bg-slate-900 px-2 py-1 rounded">
                    $ {shortTermMemory.lastExecutedCommand}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right 2 Columns: Long-Term Memory Store (LTM) */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg space-y-4">
            {/* Title & Filter Bar */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
              <div className="flex items-center space-x-2">
                <Database className="w-5 h-5 text-indigo-400" />
                <h3 className="font-bold text-base text-white">
                  Long-Term Memory Store (LTM)
                </h3>
                <span className="text-xs bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full font-mono font-semibold">
                  {longTermMemories.length} entries
                </span>
              </div>

              <div className="flex items-center space-x-2">
                {longTermMemories.length > 0 && (
                  <button
                    onClick={onClearAllMemories}
                    className="text-xs text-rose-400 hover:text-rose-300 font-mono flex items-center gap-1 px-2.5 py-1 rounded bg-slate-950 border border-slate-800 hover:border-rose-900"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>Clear LTM</span>
                  </button>
                )}
              </div>
            </div>

            {/* Filter Tabs */}
            <div className="flex items-center space-x-1.5 overflow-x-auto pb-1 text-xs font-mono">
              <span className="text-slate-500 text-[11px] flex items-center gap-1 pr-1">
                <Filter className="w-3 h-3" /> Filter:
              </span>
              {[
                { id: 'all', label: 'All' },
                { id: 'convention', label: 'Conventions' },
                { id: 'architecture', label: 'Architecture' },
                { id: 'fact', label: 'Facts' },
                { id: 'preference', label: 'Preferences' },
                { id: 'bug_note', label: 'Bug Notes' }
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setSelectedFilter(tab.id)}
                  className={`px-2.5 py-1 rounded-md transition-all shrink-0 ${
                    selectedFilter === tab.id
                      ? 'bg-indigo-600 text-white font-bold shadow'
                      : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Form to Add New Memory */}
            <form onSubmit={handleAddSubmit} className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-2.5">
              <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5 text-indigo-400" />
                Add Permanent Memory / Rule for AI Agent:
              </span>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  type="text"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="Memory Key (e.g., db_schema, UI_theme)"
                  className="bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder:text-slate-600 outline-none focus:border-indigo-500 font-mono"
                />

                <input
                  type="text"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  placeholder="Memory Content / Rule (e.g., Use Streamlit for frontend)"
                  className="sm:col-span-2 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder:text-slate-600 outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value as any)}
                  className="bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1 text-xs text-slate-300 outline-none font-mono"
                >
                  <option value="convention">Convention</option>
                  <option value="architecture">Architecture</option>
                  <option value="fact">Fact</option>
                  <option value="preference">User Preference</option>
                  <option value="bug_note">Bug Note</option>
                </select>

                <button
                  type="submit"
                  disabled={!newKey.trim() || !newValue.trim()}
                  className="px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-mono text-xs font-semibold flex items-center gap-1.5 transition-all shadow"
                >
                  <Bookmark className="w-3.5 h-3.5" />
                  <span>Remember Rule</span>
                </button>
              </div>
            </form>

            {/* Memories List */}
            <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
              {filteredMemories.length === 0 ? (
                <div className="p-8 text-center bg-slate-950/60 rounded-xl border border-slate-800 text-slate-500 text-xs space-y-2">
                  <Brain className="w-8 h-8 text-slate-700 mx-auto" />
                  <p className="font-semibold text-slate-400">No long-term memories in this view</p>
                  <p className="text-[11px] text-slate-500 max-w-sm mx-auto">
                    Add project rules or click "Auto-Extract Project Facts" to automatically memorize key project conventions!
                  </p>
                </div>
              ) : (
                filteredMemories.map((item) => (
                  <div
                    key={item.id}
                    className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-slate-700 transition-all flex items-start justify-between gap-3 group"
                  >
                    <div className="space-y-1.5 flex-1">
                      <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                        <span className="font-mono text-xs font-bold text-indigo-300">
                          {item.key}
                        </span>
                        <span
                          className={`text-[10px] px-2 py-0.2 rounded font-mono border font-semibold ${getCategoryBadgeClass(
                            item.category
                          )}`}
                        >
                          {item.category}
                        </span>
                        <span className="text-[10px] text-slate-500 font-mono">
                          Source: {item.source}
                        </span>
                      </div>

                      <p className="text-xs text-slate-200 leading-relaxed font-sans">
                        {item.value}
                      </p>

                      <div className="text-[10px] text-slate-500 font-mono pt-0.5">
                        Stored: {item.createdAt}
                      </div>
                    </div>

                    <button
                      onClick={() => onDeleteMemory(item.id)}
                      className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-slate-900 transition-colors opacity-70 group-hover:opacity-100"
                      title="Delete Memory"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
