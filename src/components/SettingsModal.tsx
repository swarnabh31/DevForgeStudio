import React from 'react';
import { Settings, X, Shield, Lock, Terminal, Cpu, Save, RotateCcw, Trash2, ScrollText } from 'lucide-react';
import { SystemSettings } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: SystemSettings;
  onUpdateSettings: (newSettings: SystemSettings) => void;
  onFactoryResetApp?: () => void;
  onOpenProjectRules?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  onFactoryResetApp,
  onOpenProjectRules
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-xl w-full p-6 shadow-2xl text-slate-100">
        <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-800">
          <div>
            <h3 className="font-bold text-base flex items-center gap-2 text-white">
              <Settings className="w-5 h-5 text-emerald-400" />
              DevForge Studio System Settings
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Configure background prerequisite auto-installation, LSP type checking, and local privacy mode.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4 text-xs">
          {/* Toggle 1: Auto Install Prerequisites */}
          <div className="flex items-center justify-between p-3 rounded-xl bg-slate-950 border border-slate-800">
            <div>
              <span className="font-semibold text-slate-200 block text-sm">Background Prerequisite Setup</span>
              <span className="text-slate-400 text-[11px]">
                Automatically installs Node runtime, Pyright, TypeScript LSP, and LangGraph framework in background.
              </span>
            </div>
            <input
              type="checkbox"
              checked={settings.autoInstallDependencies}
              onChange={(e) =>
                onUpdateSettings({ ...settings, autoInstallDependencies: e.target.checked })
              }
              className="w-4 h-4 rounded bg-slate-800 border-slate-700 text-emerald-500 focus:ring-emerald-500"
            />
          </div>

          {/* Toggle 2: LSP Diagnostics on Type */}
          <div className="flex items-center justify-between p-3 rounded-xl bg-slate-950 border border-slate-800">
            <div>
              <span className="font-semibold text-slate-200 block text-sm">LSP Real-Time Diagnostic Scanning</span>
              <span className="text-slate-400 text-[11px]">
                Runs AST and type safety checks on modified code files to feed error warnings into the LLM context.
              </span>
            </div>
            <input
              type="checkbox"
              checked={settings.lspDiagnosticsOnType}
              onChange={(e) =>
                onUpdateSettings({ ...settings, lspDiagnosticsOnType: e.target.checked })
              }
              className="w-4 h-4 rounded bg-slate-800 border-slate-700 text-emerald-500 focus:ring-emerald-500"
            />
          </div>

          {/* Toggle 3: Local Data Only */}
          <div className="flex items-center justify-between p-3 rounded-xl bg-slate-950 border border-slate-800">
            <div>
              <span className="font-semibold text-slate-200 block text-sm">Local Execution Privacy Mode</span>
              <span className="text-slate-400 text-[11px]">
                Restricts agent execution solely to in-memory local sandbox with local data processing.
              </span>
            </div>
            <input
              type="checkbox"
              checked={settings.localDataOnly}
              onChange={(e) =>
                onUpdateSettings({ ...settings, localDataOnly: e.target.checked })
              }
              className="w-4 h-4 rounded bg-slate-800 border-slate-700 text-emerald-500 focus:ring-emerald-500"
            />
          </div>

          {/* P2.4: Project Rules */}
          {onOpenProjectRules && (
            <button
              onClick={onOpenProjectRules}
              className="w-full flex items-center justify-between p-3 rounded-xl bg-slate-950 border border-slate-800 hover:border-emerald-600/60 transition-colors text-left"
            >
              <div>
                <span className="font-semibold text-slate-200 block text-sm">Project Rules</span>
                <span className="text-slate-400 text-[11px]">
                  Per-project instructions, write policy defaults, verify commands, and ignore globs (.devforge.json).
                </span>
              </div>
              <ScrollText className="w-4 h-4 text-emerald-400 shrink-0 ml-3" />
            </button>
          )}

          {/* Ollama Endpoint Input */}
          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
            <span className="font-semibold text-slate-200 block text-sm">Local Ollama Endpoint URL</span>
            <input
              type="text"
              value={settings.customOllamaEndpoint}
              onChange={(e) =>
                onUpdateSettings({ ...settings, customOllamaEndpoint: e.target.value })
              }
              placeholder="http://localhost:11434"
              className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-xs font-mono text-slate-200 focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>

        <div className="mt-6 pt-4 border-t border-slate-800 flex items-center justify-between">
          {onFactoryResetApp ? (
            <button
              onClick={() => {
                if (window.confirm("Are you sure you want to perform a full factory reset? This will clear all sessions, workspace files, and chat history.")) {
                  onFactoryResetApp();
                  onClose();
                }
              }}
              className="px-3.5 py-2 rounded-xl bg-slate-950 hover:bg-rose-950/80 text-rose-400 border border-rose-900/60 font-semibold text-xs flex items-center gap-1.5 transition-all"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Factory Reset App</span>
            </button>
          ) : (
            <div />
          )}

          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs flex items-center gap-1.5 transition-all shadow-md"
          >
            <Save className="w-3.5 h-3.5" />
            <span>Save Preferences</span>
          </button>
        </div>
      </div>
    </div>
  );
};
