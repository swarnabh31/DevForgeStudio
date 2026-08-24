import React from 'react';
import { ShieldCheck, Terminal, Cpu, RefreshCw } from 'lucide-react';

interface PrerequisitesBannerProps {
  prerequisites: unknown[];
  lspServers: unknown[];
  modelsDetected?: number;
  isScanningModels?: boolean;
  acceleration?: string;
  totalVramMB?: number;
  onOpenFirstRunGuide?: () => void;
}

/**
 * Honest environment strip. Shows only real facts: how many local models were
 * detected and what diagnostics runners exist. No invented "setup complete"
 * claims — when no models are found it says so and points at the fix.
 */
export const PrerequisitesBanner: React.FC<PrerequisitesBannerProps> = ({
  modelsDetected = 0,
  isScanningModels,
  acceleration,
  totalVramMB
}) => {
  const modelsReady = modelsDetected > 0;

  return (
    <div className="bg-slate-900 border-b border-slate-800 px-4 py-2 text-xs text-slate-300">
      <div className="w-full flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <div
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-md font-medium border ${
              modelsReady
                ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/50'
                : 'bg-amber-950/60 text-amber-400 border-amber-800/50'
            }`}
          >
            {isScanningModels ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Cpu className="w-3.5 h-3.5" />
            )}
            <span>
              {isScanningModels
                ? 'Scanning for local models…'
                : modelsReady
                  ? `${modelsDetected} local model${modelsDetected === 1 ? '' : 's'} detected`
                  : 'No local models detected'}
            </span>
          </div>

          {!modelsReady && !isScanningModels && (
            <p className="flex items-center text-slate-400">
              <Terminal className="w-3.5 h-3.5 mr-1 text-cyan-400" />
              Start Ollama (<code className="text-[11px] text-emerald-300">ollama serve</code>) and pull a
              model (<code className="text-[11px] text-emerald-300">ollama pull qwen2.5-coder:7b</code>)
              to begin.
            </p>
          )}

          <p className="hidden lg:flex items-center text-slate-500" title="Real compiler/linter runs via server/diagnostics.ts — no simulated language servers">
            <ShieldCheck className="w-3.5 h-3.5 mr-1 text-cyan-400" />
            Diagnostics: tsc --noEmit + ruff (run on demand)
          </p>
        </div>

        {acceleration && (
          <span className="hidden md:inline-flex items-center px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[11px] border border-slate-700">
            accel: {acceleration}
            {totalVramMB > 0 ? ` · ~${Math.round(totalVramMB / 1024)}GB VRAM` : ''}
          </span>
        )}
      </div>
    </div>
  );
};
