import React, { useState } from 'react';
import { 
  Users, 
  PlusCircle, 
  Bot, 
  Trash2, 
  CheckCircle2, 
  Clock, 
  Activity, 
  Layers, 
  Terminal,
  Cpu,
  Pause,
  Play,
  Square,
  Pencil,
  AlertOctagon
} from 'lucide-react';
import { AgentSession } from '../types';

interface MultiSessionManagerProps {
  sessions: AgentSession[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
  onClearAllOtherSessions?: () => void;
  onStopAgent?: (id: string) => void;
  onPauseAgent?: (id: string) => void;
  onResumeAgent?: (id: string) => void;
  onRenameAgent?: (id: string, newName: string) => void;
  onStopAllAgents?: () => void;
  onPauseAllAgents?: () => void;
}

export const MultiSessionManager: React.FC<MultiSessionManagerProps> = ({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onClearAllOtherSessions,
  onStopAgent,
  onPauseAgent,
  onResumeAgent,
  onRenameAgent,
  onStopAllAgents,
  onPauseAllAgents
}) => {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const handleStartRename = (e: React.MouseEvent, s: AgentSession) => {
    e.stopPropagation();
    setEditingSessionId(s.id);
    setEditingName(s.name);
  };

  const handleSaveRename = (id: string) => {
    if (editingName.trim() && onRenameAgent) {
      onRenameAgent(id, editingName.trim());
    }
    setEditingSessionId(null);
  };

  const hasRunningAgent = sessions.some(s => s.status === 'running');

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-xl text-slate-100 mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-3 border-b border-slate-800">
        <div>
          <h3 className="font-bold text-sm flex items-center gap-2 text-white">
            <Users className="w-4 h-4 text-emerald-400" />
            Parallel Multi-Agent Sessions ({sessions.length})
          </h3>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Run, pause, stop, and manage autonomous agent workers in parallel on the same codebase.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {hasRunningAgent && onPauseAllAgents && (
            <button
              onClick={onPauseAllAgents}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-semibold transition-all"
              title="Pause all running agents"
            >
              <Pause className="w-3.5 h-3.5" />
              <span>Pause All</span>
            </button>
          )}

          {hasRunningAgent && onStopAllAgents && (
            <button
              onClick={onStopAllAgents}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 text-xs font-semibold transition-all"
              title="Stop all running agents"
            >
              <Square className="w-3.5 h-3.5" />
              <span>Stop All</span>
            </button>
          )}

          {sessions.length > 1 && onClearAllOtherSessions && (
            <button
              onClick={() => {
                if (window.confirm("Delete all other parallel sessions and keep only active session?")) {
                  onClearAllOtherSessions();
                }
              }}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-950/60 text-slate-400 hover:text-rose-300 border border-slate-700 hover:border-rose-800/60 text-xs font-medium transition-all"
              title="Delete all other agent sessions"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear Extra Sessions</span>
            </button>
          )}

          <button
            onClick={onNewSession}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs transition-all shadow-md"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span>New Parallel Agent</span>
          </button>
        </div>
      </div>

      {/* Sessions Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {sessions.map((session) => {
          const isActive = session.id === activeSessionId;
          const isRunning = session.status === 'running';
          const isPaused = session.status === 'paused';
          const isStopped = session.status === 'stopped';

          return (
            <div
              key={session.id}
              onClick={() => onSelectSession(session.id)}
              className={`p-3 rounded-xl border transition-all cursor-pointer relative group ${
                isActive
                  ? 'bg-slate-950 border-emerald-500/80 shadow-md shadow-emerald-500/10'
                  : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center space-x-2 flex-1 min-w-0">
                  <div
                    className={`w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs shrink-0 ${
                      isActive
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                        : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    <Bot className="w-4 h-4" />
                  </div>

                  <div className="flex-1 min-w-0">
                    {editingSessionId === session.id ? (
                      <input
                        type="text"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={() => handleSaveRename(session.id)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSaveRename(session.id)}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                        className="w-full bg-slate-900 border border-emerald-500 rounded px-1.5 py-0.5 text-xs text-white outline-none font-semibold"
                      />
                    ) : (
                      <div className="flex items-center space-x-1 group/title">
                        <span className="font-semibold text-xs text-white block truncate">
                          {session.name}
                        </span>
                        <button
                          onClick={(e) => handleStartRename(e, session)}
                          className="text-slate-500 hover:text-slate-300 opacity-0 group-hover/title:opacity-100 transition-opacity"
                          title="Rename Agent"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                    <span className="text-[10px] text-slate-400 font-mono block">
                      ID: {session.id.substring(0, 8)}
                    </span>
                  </div>
                </div>

                {sessions.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteSession(session.id);
                    }}
                    className="p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-slate-800 transition-colors shrink-0 opacity-0 group-hover:opacity-100 ml-1"
                    title="Delete Agent Session"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <p className="text-[11px] text-slate-400 leading-tight mb-2.5 line-clamp-2">
                {session.description || 'General engineering agent workspace.'}
              </p>

              {/* Status & Control Actions */}
              <div className="flex items-center justify-between text-[10px] text-slate-500 pt-2 border-t border-slate-800/80">
                <span className="flex items-center gap-1 font-mono">
                  {isRunning ? (
                    <span className="text-cyan-400 font-semibold flex items-center gap-1">
                      <Activity className="w-3 h-3 animate-spin" /> Running
                    </span>
                  ) : isPaused ? (
                    <span className="text-amber-400 font-semibold flex items-center gap-1">
                      <Pause className="w-3 h-3" /> Paused
                    </span>
                  ) : isStopped ? (
                    <span className="text-rose-400 font-semibold flex items-center gap-1">
                      <Square className="w-3 h-3" /> Stopped
                    </span>
                  ) : (
                    <span className="text-emerald-400 font-semibold flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Ready
                    </span>
                  )}
                </span>

                {/* Individual Agent Control Buttons */}
                <div className="flex items-center space-x-1" onClick={(e) => e.stopPropagation()}>
                  {isRunning && onPauseAgent && (
                    <button
                      onClick={() => onPauseAgent(session.id)}
                      className="p-1 rounded bg-slate-800 hover:bg-amber-950/60 text-slate-300 hover:text-amber-300 border border-slate-700 hover:border-amber-700 transition-colors"
                      title="Pause Agent Execution"
                    >
                      <Pause className="w-3 h-3" />
                    </button>
                  )}

                  {(isRunning || isPaused) && onStopAgent && (
                    <button
                      onClick={() => onStopAgent(session.id)}
                      className="p-1 rounded bg-slate-800 hover:bg-rose-950/60 text-slate-300 hover:text-rose-300 border border-slate-700 hover:border-rose-700 transition-colors"
                      title="Stop Agent Execution"
                    >
                      <Square className="w-3 h-3" />
                    </button>
                  )}

                  {(isPaused || isStopped) && onResumeAgent && (
                    <button
                      onClick={() => onResumeAgent(session.id)}
                      className="p-1 rounded bg-slate-800 hover:bg-emerald-950/60 text-slate-300 hover:text-emerald-300 border border-slate-700 hover:border-emerald-700 transition-colors"
                      title="Resume Agent Execution"
                    >
                      <Play className="w-3 h-3" />
                    </button>
                  )}

                  <span className="font-mono text-slate-400 ml-1">
                    {session.messages.length} msgs
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
