import React from 'react';
import { 
  Bot, 
  Terminal, 
  Cpu, 
  Layers, 
  Settings, 
  ShieldCheck, 
  CheckCircle2, 
  Sparkles,
  ChevronDown,
  PlusCircle,
  Activity,
  RefreshCw,
  RotateCcw,
  Brain
} from 'lucide-react';
import { AIModel, AgentSession, TaskMode } from '../types';

const TASK_MODES: Array<{ id: TaskMode; label: string }> = [
  { id: 'general', label: 'General Q&A' },
  { id: 'coding', label: 'Coding' },
  { id: 'debugging', label: 'Debugging' },
  { id: 'testing', label: 'Test Running' },
  { id: 'test_creation', label: 'Test Creation' },
  { id: 'refactoring', label: 'Refactoring' },
  { id: 'app_development', label: 'App Development' },
  { id: 'complex_task', label: 'Complex Task' }
];

interface HeaderProps {
  currentModel: AIModel;
  availableModels: AIModel[];
  onSelectModel: (model: AIModel) => void;
  isScanningModels?: boolean;
  taskMode: TaskMode;
  onTaskModeChange: (mode: TaskMode) => void;
  systemProfile?: { acceleration: string; totalVramMB: number } | null;
  sessions: AgentSession[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onOpenModelModal: () => void;
  onOpenLspModal: () => void;
  onOpenSettingsModal: () => void;
  prerequisitesReady: boolean;
  activeTab: 'chat' | 'graph' | 'lsp' | 'memory';
  setActiveTab: (tab: 'chat' | 'graph' | 'lsp' | 'memory') => void;
  onRefreshApp?: () => void;
  onFactoryResetApp?: () => void;
}


export const Header: React.FC<HeaderProps> = ({
  currentModel,
  availableModels,
  onSelectModel,
  isScanningModels,
  taskMode,
  onTaskModeChange,
  systemProfile,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onOpenModelModal,
  onOpenLspModal,
  onOpenSettingsModal,
  prerequisitesReady,
  activeTab,
  setActiveTab,
  onRefreshApp,
  onFactoryResetApp
}) => {
  const activeSession = sessions.find(s => s.id === activeSessionId);

  return (
    <header className="sticky top-0 z-40 bg-slate-900/95 backdrop-blur-md border-b border-slate-800 text-slate-100 px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 shadow-md">
      {/* Brand & Single-Command Tag */}
      <div className="flex items-center space-x-3">
        <div className="flex items-center space-x-2">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-500 via-teal-500 to-cyan-500 p-0.5 shadow-lg shadow-emerald-500/20">
            <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
              <Bot className="w-5 h-5 text-emerald-400" />
            </div>
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-bold text-base tracking-tight text-white flex items-center gap-1.5">
                OpenCode <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30">Studio v1.0</span>
              </span>
            </div>
            <p className="text-[11px] text-slate-400 flex items-center gap-1">
              <Terminal className="w-3 h-3 text-cyan-400" /> Single-command start & auto background setup
            </p>
          </div>
        </div>

        {/* Status Pill — honest model availability */}
        <div className="hidden lg:flex items-center px-2.5 py-1 rounded-md bg-slate-800/80 border border-slate-700/60 text-xs text-slate-300">
          {isScanningModels ? (
            <span className="flex items-center text-cyan-400 font-medium">
              <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              Scanning for models…
            </span>
          ) : availableModels.length > 0 ? (
            <span className="flex items-center text-emerald-400 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5 mr-1.5 text-emerald-400" />
              {availableModels.length} local model{availableModels.length === 1 ? '' : 's'} ready
            </span>
          ) : (
            <span className="flex items-center text-amber-400 font-medium" title="Start Ollama (`ollama serve`), pull a model, then Rescan">
              <Activity className="w-3.5 h-3.5 mr-1.5" />
              No models — run `ollama serve`
            </span>
          )}
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex items-center bg-slate-950/80 p-1 rounded-lg border border-slate-800 text-xs font-medium">
        <button
          onClick={() => setActiveTab('chat')}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md transition-all ${
            activeTab === 'chat'
              ? 'bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
          }`}
        >
          <Bot className="w-3.5 h-3.5" />
          <span>Agent Chat</span>
        </button>

        <button
          onClick={() => setActiveTab('graph')}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md transition-all ${
            activeTab === 'graph'
              ? 'bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
          }`}
        >
          <Layers className="w-3.5 h-3.5" />
          <span>Agent Pipeline</span>
        </button>

        <button
          onClick={() => setActiveTab('lsp')}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md transition-all ${
            activeTab === 'lsp'
              ? 'bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
          }`}
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>LSP Diagnostics</span>
        </button>

        <button
          onClick={() => setActiveTab('memory')}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md transition-all ${
            activeTab === 'memory'
              ? 'bg-indigo-500/20 text-indigo-300 font-semibold border border-indigo-500/30 shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
          }`}
        >
          <Brain className="w-3.5 h-3.5 text-indigo-400 animate-pulse" />
          <span>Memory & Context</span>
        </button>
      </div>


      {/* Right Controls: Model Selector, Multi-Session Switcher, Settings */}
      <div className="flex items-center space-x-2">
        {/* Task Mode Dropdown (tunes model params per task) */}
        <div
          className="flex items-center rounded-lg bg-slate-800/90 border border-indigo-700/60 overflow-hidden"
          title="Task mode tunes temperature, context size and agent iterations for the best output"
        >
          <span className="pl-2.5 pr-1 text-indigo-300">
            <Sparkles className="w-3.5 h-3.5" />
          </span>
          <select
            value={taskMode}
            onChange={(e) => onTaskModeChange(e.target.value as TaskMode)}
            className="bg-transparent border-none outline-none text-xs text-white font-semibold py-1.5 pr-1 max-w-[170px] cursor-pointer appearance-none [&>option]:bg-slate-900 [&>option]:text-slate-100"
          >
            {TASK_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                Task: {m.label}
              </option>
            ))}
          </select>
        </div>

        {/* Hardware badge */}
        {systemProfile && (
          <div
            className="hidden xl:flex items-center px-2 py-1 rounded-md bg-slate-800/60 border border-slate-700/50 text-[10px] font-mono text-slate-400"
            title={`Acceleration: ${systemProfile.acceleration.toUpperCase()}${systemProfile.totalVramMB ? ` — VRAM ~${Math.round(systemProfile.totalVramMB / 1024)} GB` : ''}. Context auto-sized to your hardware.`}
          >
            <Activity className="w-3 h-3 mr-1 text-emerald-400" />
            {systemProfile.acceleration.toUpperCase()}
            {systemProfile.totalVramMB > 0 && ` · ${Math.round(systemProfile.totalVramMB / 1024)}GB`}
          </div>
        )}

        {/* Model Dropdown (auto-detected local models) */}
        <div className="flex items-center rounded-lg bg-slate-800/90 border border-slate-700 overflow-hidden">
          <span className="pl-2.5 pr-1 text-slate-400">
            {isScanningModels ? (
              <RefreshCw className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
            ) : (
              <Cpu className="w-3.5 h-3.5 text-cyan-400" />
            )}
          </span>
          <select
            value={availableModels.some((m) => m.id === currentModel.id) ? currentModel.id : ''}
            onChange={(e) => {
              const model = availableModels.find((m) => m.id === e.target.value);
              if (model) onSelectModel(model);
            }}
            disabled={availableModels.length === 0}
            title={
              availableModels.length === 0
                ? 'No local models detected — make sure Ollama or LM Studio is running'
                : 'Choose a downloaded model for your task'
            }
            className="bg-transparent border-none outline-none text-xs text-white font-semibold py-1.5 pr-1 max-w-[190px] cursor-pointer appearance-none [&>option]:bg-slate-900 [&>option]:text-slate-100"
          >
            {availableModels.length === 0 && (
              <option value="">No models detected</option>
            )}
            {availableModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name} — {model.provider}
              </option>
            ))}
          </select>
          <button
            onClick={onOpenModelModal}
            className="p-1.5 mr-0.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
            title="Model details, custom endpoint & manual add"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Multi-Session Selector */}
        <div className="relative group">
          <div className="flex items-center bg-slate-800/90 rounded-lg border border-slate-700 text-xs">
            <button
              onClick={() => onSelectSession(activeSessionId)}
              className="flex items-center space-x-1.5 px-3 py-1.5 text-slate-200 hover:text-white"
            >
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              <span className="font-medium truncate max-w-[110px]">
                {activeSession ? activeSession.name : 'Session 1'}
              </span>
              <span className="text-[10px] text-slate-400">({sessions.length})</span>
            </button>
            <button
              onClick={onNewSession}
              title="Start Parallel Agent Session"
              className="p-1.5 hover:bg-slate-700 text-emerald-400 rounded-r-lg border-l border-slate-700"
            >
              <PlusCircle className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Refresh App Button */}
        {onRefreshApp && (
          <button
            onClick={onRefreshApp}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-400 hover:text-cyan-300 border border-slate-700 transition-colors"
            title="Refresh App & Rescan Workspace/LSP"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        )}

        {/* Factory Reset App Button */}
        {onFactoryResetApp && (
          <button
            onClick={() => {
              if (window.confirm("Are you sure you want to reset the entire application? This will clear sessions, restore initial workspace files, and clear chats.")) {
                onFactoryResetApp();
              }
            }}
            className="p-2 rounded-lg bg-slate-800 hover:bg-rose-950/60 text-slate-400 hover:text-rose-300 border border-slate-700 hover:border-rose-800/60 transition-colors"
            title="Reset Application State (Factory Reset)"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        )}

        {/* Settings Button */}
        <button
          onClick={onOpenSettingsModal}
          className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors"
          title="Open System Settings"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
