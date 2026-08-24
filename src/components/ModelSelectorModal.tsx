import React, { useState } from 'react';
import { Cpu, Check, X, RefreshCw, HardDrive, Plus, Terminal, Sparkles, Server } from 'lucide-react';
import { AIModel } from '../types';

interface ModelSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentModel: AIModel;
  availableModels: AIModel[];
  onSelectModel: (model: AIModel) => void;
  onScanLocalModels: (customEndpoint?: string) => Promise<void>;
  isScanning: boolean;
  onAddManualModel: (modelTag: string) => void;
}

export const ModelSelectorModal: React.FC<ModelSelectorModalProps> = ({
  isOpen,
  onClose,
  currentModel,
  availableModels,
  onSelectModel,
  onScanLocalModels,
  isScanning,
  onAddManualModel
}) => {
  const [customEndpoint, setCustomEndpoint] = useState('http://localhost:11434');
  const [manualModelTag, setManualModelTag] = useState('');

  if (!isOpen) return null;

  const handleAddManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualModelTag.trim()) {
      onAddManualModel(manualModelTag.trim());
      setManualModelTag('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl text-slate-100 flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div>
            <h3 className="font-bold text-base flex items-center gap-2 text-white">
              <HardDrive className="w-5 h-5 text-emerald-400" />
              User Local PC System Models
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Auto-detecting downloaded models running on your local machine (Ollama, LM Studio, LocalAI).
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Local Host Scanner Bar */}
        <div className="my-4 bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2.5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
            <span className="text-slate-300 font-semibold flex items-center gap-1.5">
              <Server className="w-4 h-4 text-cyan-400" />
              Local LLM Host Server Endpoint:
            </span>
            <div className="flex items-center gap-2 flex-1 max-w-md">
              <input
                type="text"
                value={customEndpoint}
                onChange={(e) => setCustomEndpoint(e.target.value)}
                placeholder="http://localhost:11434"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-emerald-300 font-mono outline-none focus:border-emerald-500"
              />
              <button
                type="button"
                onClick={() => onScanLocalModels(customEndpoint)}
                disabled={isScanning}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 text-white font-mono text-xs font-semibold flex items-center gap-1.5 shrink-0 transition-all shadow-sm"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin text-emerald-200' : ''}`} />
                <span>{isScanning ? 'Scanning System...' : 'Auto-Scan PC'}</span>
              </button>
            </div>
          </div>

          <div className="text-[11px] text-slate-400 font-mono flex items-center gap-1.5 pt-0.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>
              Probing endpoints: <span className="text-slate-300">localhost:11434</span> (Ollama), <span className="text-slate-300">localhost:1234</span> (LM Studio), <span className="text-slate-300">localhost:8080</span>
            </span>
          </div>
        </div>

        {/* Local Models List */}
        <div className="space-y-2.5 overflow-y-auto pr-1 flex-1">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Downloaded Local Models ({availableModels.length})
            </span>
            <span className="text-[11px] text-emerald-400 font-mono">100% Offline & Air-gapped</span>
          </div>

          {availableModels.length === 0 ? (
            <div className="p-6 text-center bg-slate-950/60 rounded-xl border border-slate-800 text-slate-400 text-xs space-y-2">
              <HardDrive className="w-8 h-8 text-slate-600 mx-auto" />
              <p className="font-semibold text-slate-300">No local LLM service detected yet on localhost:11434 / localhost:1234</p>
              <p className="text-[11px] text-slate-400 max-w-md mx-auto">
                Make sure Ollama or LM Studio is started on your local machine (`ollama serve`). You can also manually type any model tag installed on your system below.
              </p>
            </div>
          ) : (
            availableModels.map((model) => {
              const isSelected = model.id === currentModel.id;

              return (
                <div
                  key={model.id}
                  onClick={() => {
                    onSelectModel(model);
                    onClose();
                  }}
                  className={`p-4 rounded-xl border transition-all cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                    isSelected
                      ? 'bg-emerald-950/50 border-emerald-500/80 shadow-lg shadow-emerald-500/10'
                      : 'bg-slate-950/80 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="space-y-1 flex-1">
                    <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                      <span className="font-bold text-sm text-white">{model.name}</span>
                      <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-emerald-300 font-mono font-medium border border-slate-700">
                        {model.provider}
                      </span>
                      <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-semibold font-mono">
                        Downloaded on System
                      </span>
                    </div>

                    <p className="text-xs text-slate-300">{model.description}</p>

                    <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400 pt-1 font-mono">
                      <span>Model Tag: <strong className="text-emerald-300">{model.id}</strong></span>
                      <span>•</span>
                      <span>{model.contextWindow}</span>
                    </div>
                  </div>

                  {isSelected && (
                    <div className="self-start sm:self-center p-1.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 shrink-0">
                      <Check className="w-4 h-4" />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Manual Local Model Addition Form */}
        <div className="mt-4 pt-3 border-t border-slate-800 space-y-2">
          <form onSubmit={handleAddManual} className="flex items-center gap-2">
            <div className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 flex items-center text-xs focus-within:border-emerald-500">
              <Terminal className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
              <input
                type="text"
                value={manualModelTag}
                onChange={(e) => setManualModelTag(e.target.value)}
                placeholder="Or specify downloaded model tag (e.g. llama3.2, qwen2.5-coder:7b, mistral:7b, deepseek-r1:14b)"
                className="w-full bg-transparent border-none outline-none text-xs text-slate-200 font-mono placeholder:text-slate-600"
              />
            </div>
            <button
              type="submit"
              disabled={!manualModelTag.trim()}
              className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white font-mono text-xs font-semibold flex items-center gap-1.5 transition-all shrink-0 border border-slate-700"
            >
              <Plus className="w-3.5 h-3.5 text-emerald-400" />
              <span>Add & Select</span>
            </button>
          </form>

          <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono px-1">
            <span className="flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-emerald-400" />
              Run models locally in terminal: <code className="text-slate-300 bg-slate-950 px-1 py-0.5 rounded">ollama run llama3.2</code> or <code className="text-slate-300 bg-slate-950 px-1 py-0.5 rounded">ollama run qwen2.5-coder:7b</code>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

