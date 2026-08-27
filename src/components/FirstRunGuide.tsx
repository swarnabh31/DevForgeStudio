import React from 'react';
import { Cpu, RefreshCw, TerminalSquare, Download, Search } from 'lucide-react';

interface FirstRunGuideProps {
  onRescan: () => void;
  isScanning?: boolean;
  onOpenWizard?: () => void;
}

const STEPS = [
  { icon: TerminalSquare, title: 'Start Ollama', cmd: 'ollama serve' },
  { icon: Download, title: 'Pull a model', cmd: 'ollama pull qwen2.5-coder:7b' },
  { icon: Search, title: 'Rescan', cmd: null }
];

export const FirstRunGuide: React.FC<FirstRunGuideProps> = ({ onRescan, isScanning, onOpenWizard }) => (
  <div className="rounded-xl border border-cyan-700/50 bg-slate-900/80 p-5 shadow-lg">
    <div className="flex items-center gap-2 mb-1">
      <Cpu className="w-5 h-5 text-cyan-400" />
      <h2 className="font-semibold text-white">No local models detected</h2>
    </div>
    <p className="text-sm text-slate-400 mb-4">
      DevForge Studio runs entirely on your machine. Get a model running in under a minute:
    </p>
    <ol className="space-y-3">
      {STEPS.map((step, i) => (
        <li key={i} className="flex items-start gap-3">
          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/20 text-cyan-300 text-xs font-bold flex items-center justify-center mt-0.5">
            {i + 1}
          </span>
          <div className="min-w-0">
            <div className="text-sm text-slate-200 flex items-center gap-1.5">
              <step.icon className="w-3.5 h-3.5 text-cyan-400" />
              {step.title}
            </div>
            {step.cmd && (
              <code className="inline-block mt-1 px-2 py-1 rounded-md bg-slate-950 border border-slate-800 text-xs font-mono text-emerald-300">
                $ {step.cmd}
              </code>
            )}
          </div>
        </li>
      ))}
    </ol>
    <button
      onClick={onRescan}
      disabled={isScanning}
      className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-600/50 text-cyan-200 text-sm font-semibold transition-colors disabled:opacity-60"
    >
      <RefreshCw className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} />
      {isScanning ? 'Scanning…' : 'Rescan for models'}
    </button>
    {onOpenWizard && (
      <button
        onClick={onOpenWizard}
        className="mt-3 w-full px-4 py-2 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-600/50 text-emerald-200 text-sm font-semibold transition-colors"
      >
        Open guided setup wizard
      </button>
    )}
    <p className="mt-3 text-xs text-slate-500">
      Using LM Studio or another OpenAI-compatible server? Start it and add its endpoint via the
      model selector (chevron next to the model dropdown).
    </p>
  </div>
);
