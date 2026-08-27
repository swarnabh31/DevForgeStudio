import React from 'react';
import {
  Columns3,
  CircleDot,
  Square,
  Pause,
  Play,
  MessageSquare,
  FileEdit,
  ArrowRight
} from 'lucide-react';
import { AgentSession } from '../types';

/**
 * P4.3: multi-task board — monitor every session's agent side-by-side:
 * live status, current objective, last activity, and one-click controls.
 */

interface TaskBoardProps {
  sessions: AgentSession[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  onStopAgent?: (sessionId?: string) => void;
  onPauseAgent?: (sessionId?: string) => void;
  onResumeAgent?: (sessionId?: string) => void;
}

const STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  running: { dot: 'bg-emerald-400 animate-pulse', label: 'Running' },
  active: { dot: 'bg-emerald-400', label: 'Active' },
  paused: { dot: 'bg-amber-400', label: 'Paused' },
  stopped: { dot: 'bg-rose-400', label: 'Stopped' },
  completed: { dot: 'bg-sky-400', label: 'Completed' },
  error: { dot: 'bg-rose-500', label: 'Error' },
  idle: { dot: 'bg-slate-500', label: 'Idle' }
};

export const TaskBoard: React.FC<TaskBoardProps> = ({
  sessions,
  activeSessionId,
  onSelectSession,
  onStopAgent,
  onPauseAgent,
  onResumeAgent
}) => {
  return (
    <div className="p-6 max-w-6xl mx-auto text-slate-100">
      <h2 className="text-lg font-bold flex items-center gap-2 mb-4">
        <Columns3 className="w-5 h-5 text-emerald-400" />
        Task Board
        <span className="text-xs font-normal text-slate-500">
          {sessions.length} session{sessions.length === 1 ? '' : 's'} · agents keep running while you watch elsewhere
        </span>
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {sessions.map((s) => {
          const st = STATUS_STYLES[s.status] || STATUS_STYLES.idle;
          const lastMsg = s.messages[s.messages.length - 1];
          const filesTouched = s.messages.reduce(
            (n, m) => n + (m.actions?.length ? 1 : 0),
            0
          );
          const isActive = s.status === 'running' || s.status === 'active';

          return (
            <div
              key={s.id}
              className={`rounded-xl border p-4 bg-slate-950/80 transition-colors ${
                s.id === activeSessionId ? 'border-emerald-600/60' : 'border-slate-800'
              }`}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <CircleDot className={`w-3 h-3 ${st.dot}`} />
                    <span className="font-semibold text-sm truncate">{s.name}</span>
                  </div>
                  <span className="text-[10px] text-slate-500 uppercase tracking-wide">{st.label}</span>
                </div>
                {s.id === activeSessionId && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">focused</span>
                )}
              </div>

              {s.assignedTask && (
                <p className="text-[11px] text-indigo-300 line-clamp-2 mb-2">{s.assignedTask}</p>
              )}

              {lastMsg && (
                <p className="text-[11px] text-slate-400 font-mono line-clamp-3 mb-3 whitespace-pre-wrap">
                  {lastMsg.content.slice(0, 220)}
                </p>
              )}

              <div className="flex items-center justify-between text-[10px] text-slate-500 mb-3">
                <span className="flex items-center gap-1">
                  <MessageSquare className="w-3 h-3" /> {s.messages.length}
                </span>
                {filesTouched > 0 && (
                  <span className="flex items-center gap-1">
                    <FileEdit className="w-3 h-3" /> {filesTouched}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => onSelectSession(s.id)}
                  disabled={s.id === activeSessionId}
                  className="px-2 py-1 rounded-md bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-[10px] flex items-center gap-1"
                >
                  <ArrowRight className="w-3 h-3" /> Focus
                </button>
                {isActive && onStopAgent && (
                  <button
                    onClick={() => onStopAgent(s.id)}
                    className="px-2 py-1 rounded-md bg-rose-900/40 hover:bg-rose-900/60 text-rose-300 text-[10px] flex items-center gap-1"
                  >
                    <Square className="w-3 h-3" /> Stop
                  </button>
                )}
                {isActive && onPauseAgent && (
                  <button
                    onClick={() => onPauseAgent(s.id)}
                    className="px-2 py-1 rounded-md bg-amber-900/40 hover:bg-amber-900/60 text-amber-300 text-[10px] flex items-center gap-1"
                  >
                    <Pause className="w-3 h-3" /> Pause
                  </button>
                )}
                {(s.status === 'paused') && onResumeAgent && (
                  <button
                    onClick={() => onResumeAgent(s.id)}
                    className="px-2 py-1 rounded-md bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-300 text-[10px] flex items-center gap-1"
                  >
                    <Play className="w-3 h-3" /> Resume
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {sessions.length === 0 && (
        <p className="text-xs text-slate-500">No sessions yet.</p>
      )}
    </div>
  );
};
