import React from 'react';
import { 
  Layers, 
  CheckCircle2, 
  Clock, 
  AlertCircle, 
  ArrowRight, 
  Code2, 
  ShieldCheck, 
  Sparkles,
  RefreshCw,
  Terminal,
  Activity
} from 'lucide-react';
import { LangGraphNodeState } from '../types';

interface AgentGraphVisualizerProps {
  nodes: LangGraphNodeState[];
  currentSessionName: string;
}

export const AgentGraphVisualizer: React.FC<AgentGraphVisualizerProps> = ({
  nodes,
  currentSessionName
}) => {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-xl text-slate-100">
      <div className="flex flex-wrap items-center justify-between pb-4 mb-4 border-b border-slate-800 gap-2">
        <div>
          <h3 className="font-bold text-base flex items-center gap-2 text-white">
            <Layers className="w-5 h-5 text-emerald-400" />
            LangGraph Agent Execution Workflow
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Active multi-step graph state loop running for session: <span className="text-emerald-300 font-semibold">{currentSessionName}</span>
          </p>
        </div>

        <div className="flex items-center space-x-2 text-xs">
          <span className="px-2.5 py-1 rounded-md bg-slate-800 text-slate-300 border border-slate-700 font-mono">
            Graph Engine: LangGraph v0.3.1
          </span>
          <span className="px-2.5 py-1 rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-medium flex items-center gap-1">
            <Activity className="w-3 h-3 text-emerald-400 animate-pulse" /> Live Graph State
          </span>
        </div>
      </div>

      {/* Nodes Flow Diagram */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-7 gap-3 my-4">
        {nodes.map((node, index) => {
          const isLast = index === nodes.length - 1;
          const isRunning = node.status === 'running';
          const isSuccess = node.status === 'success';
          const isFailed = node.status === 'failed';

          return (
            <div key={node.id} className="relative group flex flex-col justify-between">
              <div
                className={`p-3.5 rounded-xl border transition-all h-full ${
                  isRunning
                    ? 'bg-emerald-950/40 border-emerald-500/80 shadow-lg shadow-emerald-500/10'
                    : isSuccess
                    ? 'bg-slate-950/80 border-slate-800 hover:border-slate-700'
                    : isFailed
                    ? 'bg-rose-950/30 border-rose-800/80'
                    : 'bg-slate-950/40 border-slate-800/60 opacity-60'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-mono text-slate-400 font-medium">
                    Node 0{index + 1}
                  </span>
                  {isSuccess ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : isRunning ? (
                    <RefreshCw className="w-4 h-4 text-cyan-400 animate-spin" />
                  ) : isFailed ? (
                    <AlertCircle className="w-4 h-4 text-rose-400" />
                  ) : (
                    <Clock className="w-4 h-4 text-slate-600" />
                  )}
                </div>

                <div className="font-semibold text-xs text-slate-100 mb-1 leading-snug">
                  {node.label}
                </div>

                <p className="text-[11px] text-slate-400 leading-tight mb-2">
                  {node.message || 'Node state idle'}
                </p>

                {node.durationMs && (
                  <div className="mt-auto text-[10px] font-mono text-slate-500 border-t border-slate-800/80 pt-1.5 flex justify-between">
                    <span>Duration:</span>
                    <span className="text-emerald-400">{node.durationMs}ms</span>
                  </div>
                )}
              </div>

              {!isLast && (
                <div className="hidden lg:block absolute -right-2 top-1/2 -translate-y-1/2 z-10 text-slate-600">
                  <ArrowRight className="w-3.5 h-3.5 text-slate-600" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Graph State Meta */}
      <div className="mt-4 pt-3 border-t border-slate-800 flex flex-wrap items-center justify-between text-xs text-slate-400 gap-2">
        <div className="flex items-center space-x-4">
          <span className="flex items-center gap-1.5 text-slate-300">
            <ShieldCheck className="w-4 h-4 text-emerald-400" /> LSP Verification Loop: <strong className="text-emerald-300 font-mono ml-1">ENFORCED</strong>
          </span>
          <span className="flex items-center gap-1.5 text-slate-300">
            <Code2 className="w-4 h-4 text-cyan-400" /> Self-Correction Max Retries: <strong className="text-slate-200 font-mono ml-1">3 Loops</strong>
          </span>
        </div>

        <div className="text-[11px] text-slate-500 italic">
          *LangGraph graph state automatically rolls back file mutations if LSP diagnostics reveal unhandled type errors.
        </div>
      </div>
    </div>
  );
};
