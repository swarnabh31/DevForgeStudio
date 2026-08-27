/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { PrerequisitesBanner } from './components/PrerequisitesBanner';
import { ChatInterface } from './components/ChatInterface';
import { CodeWorkspace } from './components/CodeWorkspace';
import { AgentGraphVisualizer } from './components/AgentGraphVisualizer';
import { LspPanel } from './components/LspPanel';
import { MultiSessionManager } from './components/MultiSessionManager';
import { ModelSelectorModal } from './components/ModelSelectorModal';
import { SettingsModal } from './components/SettingsModal';
import { ProjectRulesModal } from './components/ProjectRulesModal';
import { StatsDashboard } from './components/StatsDashboard';
import { OnboardingWizard } from './components/OnboardingWizard';
import { TaskBoard } from './components/TaskBoard';
import { DocsPanel } from './components/DocsPanel';
import { MemoryInspector } from './components/MemoryInspector';
import { CheckpointTimeline } from './components/CheckpointTimeline';
import { EditReviewModal, PendingReview } from './components/EditReviewModal';
import { LiveDashboard, PlanStep, ToolFeedEntry, IterStat } from './components/LiveDashboard';
import { FirstRunGuide } from './components/FirstRunGuide';

import { 
  AIModel, 
  AgentSession, 
  ChatMessage, 
  AttachmentFile, 
  WorkspaceFile, 
  LSPDiagnostic, 
  LSPServerStatus, 
  PrerequisiteStatus, 
  LangGraphNodeState, 
  SystemSettings,
  ThinkingLevel,
  LongTermMemoryItem,
  ShortTermMemoryState
} from './types';


import { DEFAULT_LOCAL_MODEL, createLocalModelObject } from './data/models';
import type { TaskMode, SystemProfile } from './types';
import { DEFAULT_WORKSPACE_FILES, INITIAL_LSP_SERVERS, INITIAL_PREREQUISITES } from './data/defaultWorkspace';

export default function App() {
  // Global State
  const [availableModels, setAvailableModels] = useState<AIModel[]>([]);
  const [currentModel, setCurrentModel] = useState<AIModel>(DEFAULT_LOCAL_MODEL);
  const [isScanningModels, setIsScanningModels] = useState<boolean>(false);
  const [livePlan, setLivePlan] = useState<string[]>([]);
  const [liveIteration, setLiveIteration] = useState<number>(0);
  // P1.5c: live context budget meter fed by `context_usage` stream events
  const [contextUsage, setContextUsage] = useState<{ usedTokens: number; budgetTokens: number } | null>(null);
  // P2.3 live dashboard state (all from structured events)
  const [dashPlan, setDashPlan] = useState<PlanStep[]>([]);
  const [dashToolFeed, setDashToolFeed] = useState<ToolFeedEntry[]>([]);
  const [dashFiles, setDashFiles] = useState<string[]>([]);
  const [dashIterStats, setDashIterStats] = useState<IterStat[]>([]);
  const [taskMode, setTaskMode] = useState<TaskMode>('coding');
  // P2.2: write policy — 'review' gates every edit behind per-hunk diff review
  const [writePolicy, setWritePolicy] = useState<'ask' | 'allow' | 'deny' | 'review'>('ask');
  const [pendingReview, setPendingReview] = useState<PendingReview | null>(null);
  const [systemProfile, setSystemProfile] = useState<SystemProfile | null>(null);
  const [activeTab, setActiveTab] = useState<'chat' | 'graph' | 'lsp' | 'memory' | 'checkpoints' | 'stats' | 'board' | 'docs'>('chat');
  const [longTermMemories, setLongTermMemories] = useState<LongTermMemoryItem[]>([]);

  // Memory Handlers
  const fetchMemories = async () => {
    try {
      const res = await fetch('/api/memory');
      if (res.ok) {
        const data = await res.json();
        if (data.longTermMemories) {
          setLongTermMemories(data.longTermMemories);
        }
      }
    } catch (e) {
      console.warn('Memory fetch notice:', e);
    }
  };

  const handleAddMemory = async (key: string, value: string, category: LongTermMemoryItem['category']) => {
    try {
      const res = await fetch('/api/memory/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value, category })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.longTermMemories) {
          setLongTermMemories(data.longTermMemories);
        }
      }
    } catch (e) {
      console.error('Failed to add memory', e);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    try {
      const res = await fetch(`/api/memory/${id}`, { method: 'DELETE' });
      if (res.ok) {
        const data = await res.json();
        if (data.longTermMemories) {
          setLongTermMemories(data.longTermMemories);
        }
      }
    } catch (e) {
      console.error('Failed to delete memory', e);
    }
  };

  const handleClearAllMemories = async () => {
    try {
      const res = await fetch('/api/memory/clear', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setLongTermMemories(data.longTermMemories || []);
      }
    } catch (e) {
      console.error('Failed to clear memories', e);
    }
  };

  const handleAutoExtractMemories = async () => {
    try {
      const res = await fetch('/api/memory/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.longTermMemories) {
          setLongTermMemories(data.longTermMemories);
        }
      }
    } catch (e) {
      console.error('Failed to extract memories', e);
    }
  };

  useEffect(() => {
    fetchMemories();
  }, []);

  const [prerequisites, setPrerequisites] = useState<PrerequisiteStatus[]>(INITIAL_PREREQUISITES);
  const [lspServers, setLspServers] = useState<LSPServerStatus[]>(INITIAL_LSP_SERVERS);
  const [prerequisitesReady, setPrerequisitesReady] = useState(true);

  // Multi-Session Management with localStorage Persistence
  // (legacy "opencode_*" keys are migrated to "devforge_*" on first read)
  const [sessions, setSessions] = useState<AgentSession[]>(() => {
    try {
      let saved = localStorage.getItem('devforge_sessions');
      if (!saved) {
        saved = localStorage.getItem('opencode_sessions');
        if (saved) {
          localStorage.setItem('devforge_sessions', saved);
          localStorage.removeItem('opencode_sessions');
        }
      }
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (e) {
      console.warn('Failed to parse saved sessions from localStorage:', e);
    }
    return [
      {
        id: 'session-default-1',
        name: 'Main Refactoring Agent',
        description: 'Primary software engineering agent handling API implementation & LSP verification.',
        status: 'idle',
        modelId: DEFAULT_LOCAL_MODEL.id,
        createdAt: new Date().toLocaleTimeString(),
        updatedAt: new Date().toLocaleTimeString(),
        messages: [
          {
            id: 'msg-welcome',
            sender: 'agent',
            content: `Welcome to DevForge Studio! 🚀

I am your open-source autonomous AI coding workspace. I can help you write, refactor, run tests, diagnose language server errors, and execute code in parallel sessions using your local system LLM.

What would you like to build or inspect today?`,
            timestamp: new Date().toLocaleTimeString()
          }
        ],
        progress: 100,
        logs: ['Session initialized with LangGraph pipeline', 'LSP diagnostics engine attached'],
        currentLspDiagnostics: [],
        isolatedWorkspaceFiles: { ...DEFAULT_WORKSPACE_FILES }
      }
    ];
  });

  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    try {
      let saved = localStorage.getItem('devforge_active_session_id');
      if (!saved) {
        saved = localStorage.getItem('opencode_active_session_id');
        if (saved) localStorage.setItem('devforge_active_session_id', saved);
      }
      if (saved) return saved;
    } catch (e) {}
    return 'session-default-1';
  });

  // Persisted workspace folder path (survives tab switches & reloads)
  // Resizable split between Agent Chat and Code Workspace sidebar
  const [workspaceWidth, setWorkspaceWidth] = useState<number | null>(null);
  const splitterDrag = useRef<{ startX: number; startW: number } | null>(null);

  const handleSplitterMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startW = workspaceWidth ?? 460;
    splitterDrag.current = { startX: e.clientX, startW };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      if (!splitterDrag.current) return;
      const w = Math.min(Math.max(splitterDrag.current.startW + (splitterDrag.current.startX - ev.clientX), 320), window.innerWidth - 480);
      setWorkspaceWidth(w);
    };
    const onUp = () => {
      splitterDrag.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const [targetFolderPath, setTargetFolderPath] = useState<string>(() => {    try {
      const saved = localStorage.getItem('devforge_target_folder') || localStorage.getItem('opencode_target_folder') || '';
      if (saved) localStorage.setItem('devforge_target_folder', saved);
      return saved;
    } catch {
      return '';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('devforge_target_folder', targetFolderPath);
    } catch {}
  }, [targetFolderPath]);

  // Sync sessions to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('devforge_sessions', JSON.stringify(sessions));
    } catch (e) {
      console.warn('Failed to sync sessions to localStorage:', e);
    }
    // Mirror chat history to the local server so it survives storage wipes
    fetch('/api/sync/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessions: sessions.map((s) => ({ id: s.id, name: s.name, messages: s.messages }))
      })
    }).catch(() => {});
  }, [sessions]);

  // Restore chat history from the server on boot (covers cleared localStorage)
  useEffect(() => {
    fetch('/api/sync/sessions')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.sessions?.length) return;
        setSessions((prev) => {
          const byId = new Map(prev.map((s) => [s.id, s]));
          for (const remote of data.sessions) {
            const local = byId.get(remote.id);
            const remoteCount = Array.isArray(remote.messages) ? remote.messages.length : 0;
            if (!local && remoteCount > 0) {
              byId.set(remote.id, {
                id: remote.id,
                name: remote.name || remote.id,
                description: 'Restored from server history',
                status: 'idle',
                modelId: DEFAULT_LOCAL_MODEL.id,
                createdAt: remote.updatedAt,
                updatedAt: remote.updatedAt,
                messages: remote.messages,
                progress: 100,
                logs: ['Restored from .opencode/store.json'],
                currentLspDiagnostics: [],
                isolatedWorkspaceFiles: {}
              } as AgentSession);
            } else if (local && remoteCount > local.messages.length) {
              byId.set(remote.id, { ...local, messages: remote.messages });
            }
          }
          return [...byId.values()];
        });
      })
      .catch(() => {});
  }, []);

  // Sync activeSessionId to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('devforge_active_session_id', activeSessionId);
    } catch (e) {}
  }, [activeSessionId]);

  // Active Session Shortcut
  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0];

  // Workspace Files state
  const [workspaceFiles, setWorkspaceFiles] = useState<Record<string, WorkspaceFile>>(
    activeSession ? activeSession.isolatedWorkspaceFiles : { ...DEFAULT_WORKSPACE_FILES }
  );
  const [activeFilePath, setActiveFilePath] = useState<string>('src/index.ts');

  // LSP Diagnostics State
  const [diagnostics, setDiagnostics] = useState<LSPDiagnostic[]>([]);

  // Execution Terminal State
  const [commandOutput, setCommandOutput] = useState<string>('');
  const [isExecuting, setIsExecuting] = useState<boolean>(false);
  const [isAgentRunning, setIsAgentRunning] = useState<boolean>(false);
  const streamAbortRef = useRef<AbortController | null>(null);

  // Modals
  const [isModelModalOpen, setIsModelModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isProjectRulesOpen, setIsProjectRulesOpen] = useState(false);
  // P4.1: onboarding wizard auto-opens once on first visit
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(() => {
    try {
      return !localStorage.getItem('devforge_onboardingDone');
    } catch {
      return false;
    }
  });
  const [chatDraft, setChatDraft] = useState<{ text: string; id: number } | null>(null);

  const closeOnboarding = () => {
    setIsOnboardingOpen(false);
    try {
        localStorage.setItem('devforge_onboardingDone', '1');
    } catch {}
  };

  // Settings
  const [settings, setSettings] = useState<SystemSettings>({
    autoInstallDependencies: true,
    lspDiagnosticsOnType: true,
    autoFixLspErrors: true,
    maxParallelSessions: 4,
    localDataOnly: true,
    customOllamaEndpoint: 'http://localhost:11434'
  });

  // Local Models Detection Logic
  const scanAndDetectLocalModels = async (customEndpoint?: string) => {
    setIsScanningModels(true);
    const endpointToUse = customEndpoint || settings.customOllamaEndpoint || 'http://localhost:11434';
    
    let detectedList: AIModel[] = [];
    const seenIds = new Set<string>();

    // 1. Try server backend detection endpoint
    try {
      const res = await fetch('/api/models/detect-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customEndpoint: endpointToUse })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.models && Array.isArray(data.models)) {
          data.models.forEach((m: any) => {
            if (!seenIds.has(m.id)) {
              seenIds.add(m.id);
              detectedList.push(createLocalModelObject(m.id, { size: m.size, family: m.family, parameter_size: m.parameterSize, provider: m.provider, endpoint: m.endpoint }));
            }
          });
        }
      }
    } catch (err) {
      console.warn('Backend local model scan notice:', err);
    }

    // 2. Direct browser fetch to local Ollama server if accessible
    try {
      const cleanEp = endpointToUse.replace(/\/$/, '');
      const resp = await fetch(`${cleanEp}/api/tags`, { method: 'GET', headers: { 'Accept': 'application/json' } });
      if (resp.ok) {
        const data = await resp.json();
        if (data.models && Array.isArray(data.models)) {
          data.models.forEach((m: any) => {
            const mId = m.name || m.model;
            if (mId && !seenIds.has(mId)) {
              seenIds.add(mId);
              detectedList.push(createLocalModelObject(mId, { size: m.size, family: m.details?.family, parameter_size: m.details?.parameter_size, provider: 'Ollama (Local)', endpoint: cleanEp }));
            }
          });
        }
      }
    } catch (err) {}

    if (detectedList.length > 0) {
      setAvailableModels(detectedList);
      if (currentModel.id === 'local-auto-detected' || !seenIds.has(currentModel.id)) {
        setCurrentModel(detectedList[0]);
      }
    } else {
      // No local LLM service reachable — show empty list; the dropdown reports it
      setAvailableModels([]);
    }

    setIsScanningModels(false);
  };

  const handleAddManualModel = (modelTag: string) => {
    const newModel = createLocalModelObject(modelTag);
    setAvailableModels((prev) => {
      const filtered = prev.filter((m) => m.id !== 'local-auto-detected' && m.id !== modelTag);
      return [newModel, ...filtered];
    });
    setCurrentModel(newModel);
  };

  // Run model scan + hardware profile on mount
  useEffect(() => {
    scanAndDetectLocalModels();
    fetch('/api/system/profile')
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => p && setSystemProfile(p))
      .catch(() => {});
  }, []);

  // Re-scan when model modal opens
  useEffect(() => {
    if (isModelModalOpen) {
      scanAndDetectLocalModels();
    }
  }, [isModelModalOpen]);

  // Keep active workspace in sync with session

  useEffect(() => {
    if (activeSession) {
      setWorkspaceFiles(activeSession.isolatedWorkspaceFiles);
    }
  }, [activeSessionId]);

  // Initial LSP diagnostic scan
  useEffect(() => {
    fetchLspDiagnostics();
  }, [workspaceFiles]);

  const fetchLspDiagnostics = async () => {
    try {
      const res = await fetch('/api/lsp/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId })
      });
      const data = await res.json();
      if (data.diagnostics) {
        setDiagnostics(data.diagnostics);
      }
    } catch (e) {
      console.error('LSP fetch error:', e);
    }
  };

  // Create new parallel agent session
  const handleNewSession = () => {
    const newId = `session-${Date.now()}`;
    const count = sessions.length + 1;
    const newSession: AgentSession = {
      id: newId,
      name: `Parallel Agent #${count}`,
      description: `Concurrent autonomous agent operating on shared project workspace.`,
      status: 'idle',
      modelId: currentModel.id,
      createdAt: new Date().toLocaleTimeString(),
      updatedAt: new Date().toLocaleTimeString(),
      messages: [
        {
          id: `msg-${Date.now()}`,
          sender: 'agent',
          content: `Parallel Agent #${count} booted! Ready to run tasks concurrently on the project workspace.`,
          timestamp: new Date().toLocaleTimeString()
        }
      ],
      progress: 0,
      logs: ['Parallel session created.'],
      currentLspDiagnostics: [],
      isolatedWorkspaceFiles: { ...DEFAULT_WORKSPACE_FILES }
    };

    setSessions((prev) => [...prev, newSession]);
    setActiveSessionId(newId);
  };

  const handleDeleteSession = (id: string) => {
    if (sessions.length <= 1) return;
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeSessionId === id) {
      const remaining = sessions.filter((s) => s.id !== id);
      setActiveSessionId(remaining[0].id);
    }
  };

  // Handle User Message Dispatch to LangGraph Agent
  const handleSendMessage = async (
    prompt: string, 
    attachments: AttachmentFile[], 
    thinkingLevel: ThinkingLevel = 'none'
  ) => {
    // U6: /commands
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt === '/new-session') {
      handleNewSession();
      return;
    }
    if (trimmedPrompt.startsWith('/test')) {
      prompt = 'Run the project verification commands using run_command (try "npm run lint", then "npm test" or the appropriate test runner for this workspace). Report pass/fail and any failures precisely.';
    } else if (trimmedPrompt.startsWith('/fix')) {
      prompt = 'Check real diagnostics (run_command with tsc --noEmit or npm run lint). If there are errors, fix them with apply_patch, then re-run to verify.';
    } else if (trimmedPrompt.startsWith('/explain')) {
      const target = trimmedPrompt.slice('/explain'.length).trim();
      prompt = `Explain in detail: ${target || 'the currently open/active files in this workspace'}`;
    }

    setIsAgentRunning(true);

    const userMsg: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      sender: 'user',
      content: prompt,
      timestamp: new Date().toLocaleTimeString(),
      attachments,
      thinkingLevel
    };

    // Append user message immediately
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === activeSessionId) {
          return {
            ...s,
            status: 'running',
            thinkingLevel,
            messages: [...s.messages, userMsg]
          };
        }
        return s;
      })
    );

    const currentSession = sessions.find((s) => s.id === activeSessionId);
    // Include the message we just appended (the render-time `sessions` closure
    // is one turn behind setSessions above).
    const sessionHistory = [...(currentSession?.messages || []), userMsg];

    // Streaming run: placeholder agent message updated token-by-token
    const agentMsgId = `msg-agent-${Date.now()}`;
    let streamingContent = '';
    const appendAgentMsg = (updates: Partial<ChatMessage> = {}) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== activeSessionId) return s;
          const existing = s.messages.find((m) => m.id === agentMsgId);
          const base: ChatMessage = existing || {
            id: agentMsgId,
            sender: 'agent',
            content: '',
            timestamp: new Date().toLocaleTimeString(),
            thinkingLevel
          };
          const merged = { ...base, ...updates };
          if (existing && updates.content !== undefined) merged.content = updates.content;
          return {
            ...s,
            messages: existing
              ? s.messages.map((m) => (m.id === agentMsgId ? merged : m))
              : [...s.messages, merged]
          };
        })
      );
    };

    try {
      setLivePlan([]);
      setLiveIteration(0);
      setContextUsage(null);
      setDashPlan([]);
      setDashToolFeed([]);
      setDashFiles([]);
      setDashIterStats([]);
      const localAbort = new AbortController();
      streamAbortRef.current = localAbort;

      const res = await fetch('/api/agent/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: localAbort.signal,
        body: JSON.stringify({
          prompt,
          modelId: currentModel.id,
          modelEndpoint: currentModel.endpoint,
          sessionId: activeSessionId,
          attachments,
          thinkingLevel,
          taskMode,
          writePolicy,
          history: sessionHistory.map((m) => ({
            sender: m.sender,
            content: m.content
          }))
        })
      });

      if (!res.ok || !res.body) throw new Error('stream unavailable');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let donePayload: any = null;
      const collectedActions: any[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let evt: any;
          try { evt = JSON.parse(line); } catch { continue; }

          if (evt.type === 'plan') {
            setLivePlan(evt.items || []);
            setLiveIteration(0);
          } else if (evt.type === 'plan_update') {
            // P1.3 structured plan events (preferred over regex-scraped prose)
            const steps = evt.steps || [];
            setLivePlan(steps.map((s: any) => `${s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '▸' : '○'} ${s.text}`));
            setLiveIteration(steps.filter((s: any) => s.status === 'completed').length);
            setDashPlan(steps.map((s: any) => ({ text: s.text, status: s.status })));
          } else if (evt.type === 'iteration') {
            setLiveIteration(evt.index);
            setDashToolFeed((prev) => prev); // feed updated on tool_call/tool_result
          } else if (evt.type === 'iteration_end') {
            setDashIterStats((prev) => [
              ...prev.slice(-29),
              {
                index: evt.index,
                durationMs: evt.durationMs || 0,
                promptEvalMs: (evt as any).promptEvalMs,
                promptEvalTokens: (evt as any).promptEvalTokens
              }
            ]);
          } else if (evt.type === 'tool_call') {
            setDashToolFeed((prev) => [...prev, { name: evt.name, ok: undefined }]);
          } else if (evt.type === 'context_usage') {
            setContextUsage({ usedTokens: evt.usedTokens || 0, budgetTokens: evt.budgetTokens || 0 });
          } else if (evt.type === 'token') {
            streamingContent += evt.delta;
            appendAgentMsg({ content: streamingContent });
          } else if (evt.type === 'tool_call') {
            appendAgentMsg({
              content: `${streamingContent}\n\n🔧 \`${evt.name}\`…`
            });
            setDashToolFeed((prev) => [...prev, { name: evt.name, ok: undefined }]);
          } else if (evt.type === 'tool_result') {
            setDashToolFeed((prev) => {
              const next = [...prev];
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].ok === undefined && next[i].name === evt.result?.name) {
                  next[i] = { ...next[i], ok: !!evt.result?.ok };
                  break;
                }
              }
              return next;
            });
          } else if (evt.type === 'files_changed' && Array.isArray(evt.files)) {
            setDashFiles(evt.files);
          } else if (evt.type === 'permission_request') {
            const ok = window.confirm(
              `DevForge Agent requests permission:\n\n${evt.toolName}: ${evt.summary}\n\nAllow this action?`
            );
            fetch('/api/agent/permission', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId: evt.runId, allowed: ok })
            }).catch(() => {});
            if (!ok) streamingContent += `\n\n🚫 Permission denied for \`${evt.toolName}\`.`;
          } else if (evt.type === 'edit_review_request') {
            setPendingReview({
              runId: evt.runId,
              toolName: evt.toolName,
              path: evt.path,
              isNewFile: !!evt.isNewFile,
              hunks: evt.hunks || []
            });
          } else if (evt.type === 'files_changed') {
            // refresh workspace cache live
            fetch(`/api/workspace/files?sessionId=${activeSessionId}`)
              .then((r) => r.json())
              .then((d) => d.files && setWorkspaceFiles(d.files))
              .catch(() => {});
          } else if (evt.type === 'verify_start') {
            streamingContent += `\n\n🔍 Verifying (${(evt.commands || []).join(', ')})…`;
            appendAgentMsg({ content: streamingContent });
          } else if (evt.type === 'verify_result') {
            streamingContent += evt.ok
              ? `\n✅ Verification passed`
              : `\n❌ Verification failed — auto-healing…`;
            appendAgentMsg({ content: streamingContent });
          } else if (evt.type === 'done') {
            donePayload = evt.payload;
          } else if (evt.type === 'error') {
            streamingContent += `\n\n⚠ ${evt.error}`;
            appendAgentMsg({ content: streamingContent });
          }
        }
      }

      const data = donePayload || { reply: streamingContent || 'Task completed.' };
      const finalContent = data.reply || streamingContent || 'Task completed.';
      const agentActions = collectedActions.length ? collectedActions : data.actions;

      // Refresh workspace files after run
      const updatedFilesRes = await fetch(`/api/workspace/files?sessionId=${activeSessionId}`);
      const updatedFilesData = await updatedFilesRes.json();
      if (updatedFilesData.files) {
        setWorkspaceFiles(updatedFilesData.files);
      }
      if (data.lspDiagnostics) {
        setDiagnostics(data.lspDiagnostics);
      }

      appendAgentMsg({
        content: finalContent,
        actions: agentActions,
        lspDiagnostics: data.lspDiagnostics,
        filePatches: data.filePatches,
        graphState: data.graphState
      });
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeSessionId
            ? { ...s, status: 'completed', isolatedWorkspaceFiles: updatedFilesData.files || s.isolatedWorkspaceFiles }
            : s
        )
      );
      notifyIfBackground(
        `✅ ${activeSession.name} finished`,
        (finalContent || 'Task completed.').slice(0, 120)
      );
    } catch (err) {
      console.error('Agent execution error:', err);
      const errorMsg: ChatMessage = {
        id: `msg-err-${Date.now()}`,
        sender: 'agent',
        content: `⚠ Could not complete this request.\n\n${
          /ECONNREFUSED|ENOTFOUND|fetch failed|Failed to fetch/i.test(String(err))
            ? 'Your local model server appears unreachable.\n\n1) Start it: `ollama serve` (or launch LM Studio)\n2) Pull a model if needed: `ollama pull qwen2.5-coder:7b`\n3) Press Rescan in the header, then try again.'
            : String((err as Error)?.message || err)
        }`,
        timestamp: new Date().toLocaleTimeString()
      };

      setSessions((prev) =>
        prev.map((s) => {
          if (s.id === activeSessionId) {
            return {
              ...s,
              status: 'idle',
              messages: [...s.messages, errorMsg]
            };
          }
          return s;
        })
      );
      notifyIfBackground(`⚠ ${activeSession.name} failed`, String((err as Error)?.message || 'Run failed').slice(0, 120));
    } finally {
      setIsAgentRunning(false);
    }
  };

  // Quick prompt action trigger
  const handleQuickAction = (actionText: string) => {
    handleSendMessage(actionText, []);
  };

  // P4.3: desktop notification for background runs (only when tab is hidden)
  const notifyIfBackground = (title: string, body: string) => {
    try {
      if (!document.hidden || typeof Notification === 'undefined') return;
      if (Notification.permission === 'granted') {
        new Notification(title, { body });
      } else if (Notification.permission === 'default') {
        Notification.requestPermission().then((p) => {
          if (p === 'granted') new Notification(title, { body });
        });
      }
    } catch {}
  };

  // Command Execution in Sandbox
  const handleExecuteCommand = async (cmd: string) => {
    setIsExecuting(true);
    try {
      const res = await fetch('/api/workspace/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, sessionId: activeSessionId })
      });
      const data = await res.json();
      setCommandOutput(data.stdout || '');
    } catch (e) {
      console.error('Command execution error:', e);
      setCommandOutput(`$ ${cmd}\nCommand failed to run in sandbox.`);
    } finally {
      setIsExecuting(false);
    }
  };

  // Save workspace file edits
  const handleSaveFile = async (filePath: string, content: string, imported?: boolean) => {
    try {
      const res = await fetch('/api/workspace/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: filePath,
          content,
          sessionId: activeSessionId,
          imported
        })
      });
      const data = await res.json();
      if (data.file) {
        setWorkspaceFiles((prev) => ({
          ...prev,
          [filePath]: data.file
        }));
      }
      if (data.diagnostics) {
        setDiagnostics(data.diagnostics);
      }
    } catch (e) {
      console.error('File save error:', e);
    }
  };

  // Delete a specific file from active workspace
  const handleDeleteFile = (filePath: string) => {
    setWorkspaceFiles((prev) => {
      const next = { ...prev };
      delete next[filePath];
      return next;
    });

    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === activeSessionId) {
          const nextIso = { ...s.isolatedWorkspaceFiles };
          delete nextIso[filePath];
          return { ...s, isolatedWorkspaceFiles: nextIso };
        }
        return s;
      })
    );

    if (activeFilePath === filePath) {
      const remainingKeys = Object.keys(workspaceFiles).filter((k) => k !== filePath);
      setActiveFilePath(remainingKeys[0] || '');
    }
  };

  // Clear all workspace files
  const handleClearWorkspace = () => {
    setWorkspaceFiles({});
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === activeSessionId) {
          return { ...s, isolatedWorkspaceFiles: {} };
        }
        return s;
      })
    );
    setActiveFilePath('');
  };

  // Reset workspace to default template files
  const handleResetWorkspace = () => {
    setWorkspaceFiles({ ...DEFAULT_WORKSPACE_FILES });
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === activeSessionId) {
          return { ...s, isolatedWorkspaceFiles: { ...DEFAULT_WORKSPACE_FILES } };
        }
        return s;
      })
    );
    setActiveFilePath('README.md');
    fetchLspDiagnostics();
  };

  // Clear messages in active chat session
  const handleClearChat = () => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === activeSessionId) {
          return {
            ...s,
            messages: [
              {
                id: `msg-welcome-${Date.now()}`,
                sender: 'agent',
                content: `Chat history cleared. How can I help you with your code today?`,
                timestamp: new Date().toLocaleTimeString()
              }
            ]
          };
        }
        return s;
      })
    );
  };

  // Delete a single message from active session
  const handleDeleteMessage = (msgId: string) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === activeSessionId) {
          return {
            ...s,
            messages: s.messages.filter((m) => m.id !== msgId)
          };
        }
        return s;
      })
    );
  };

  // Stop agent execution for a session
  const handleStopAgent = (sessionId?: string) => {
    const id = sessionId || activeSessionId;
    // RE2/L5: actually abort the in-flight stream + server-side loop
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    fetch('/api/agent/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: id })
    }).catch(() => {});
    if (id === activeSessionId) {
      setIsAgentRunning(false);
    }
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === id) {
          const stopMsg: ChatMessage = {
            id: `msg-stop-${Date.now()}`,
            sender: 'system',
            content: '🛑 Agent execution was stopped by user.',
            timestamp: new Date().toLocaleTimeString()
          };
          return {
            ...s,
            status: 'stopped',
            messages: [...s.messages, stopMsg]
          };
        }
        return s;
      })
    );
  };

  // Pause agent execution for a session
  const handlePauseAgent = (sessionId?: string) => {
    const id = sessionId || activeSessionId;
    if (id === activeSessionId) {
      setIsAgentRunning(false);
    }
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === id) {
          const pauseMsg: ChatMessage = {
            id: `msg-pause-${Date.now()}`,
            sender: 'system',
            content: '⏸️ Agent execution paused. Click Resume to continue.',
            timestamp: new Date().toLocaleTimeString()
          };
          return {
            ...s,
            status: 'paused',
            messages: [...s.messages, pauseMsg]
          };
        }
        return s;
      })
    );
  };

  // Resume agent execution for a session
  const handleResumeAgent = (sessionId?: string) => {
    const id = sessionId || activeSessionId;
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === id) {
          const resumeMsg: ChatMessage = {
            id: `msg-resume-${Date.now()}`,
            sender: 'system',
            content: '▶️ Agent execution resumed.',
            timestamp: new Date().toLocaleTimeString()
          };
          return {
            ...s,
            status: 'running',
            messages: [...s.messages, resumeMsg]
          };
        }
        return s;
      })
    );
    if (id === activeSessionId) {
      setIsAgentRunning(true);
      setTimeout(() => {
        setIsAgentRunning(false);
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, status: 'completed' } : s))
        );
      }, 1000);
    }
  };

  // Rename agent session
  const handleRenameAgent = (sessionId: string, newName: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, name: newName } : s))
    );
  };

  // Stop All Running Agents
  const handleStopAllAgents = () => {
    setIsAgentRunning(false);
    setSessions((prev) =>
      prev.map((s) => (s.status === 'running' || s.status === 'paused' ? { ...s, status: 'stopped' } : s))
    );
  };

  // Pause All Running Agents
  const handlePauseAllAgents = () => {
    setIsAgentRunning(false);
    setSessions((prev) =>
      prev.map((s) => (s.status === 'running' ? { ...s, status: 'paused' } : s))
    );
  };

  // Refresh application state, re-sync workspace & LSP
  const handleRefreshApp = async () => {
    try {
      await fetchLspDiagnostics();
      const updatedFilesRes = await fetch(`/api/workspace/files?sessionId=${activeSessionId}`);
      const updatedFilesData = await updatedFilesRes.json();
      if (updatedFilesData.files) {
        setWorkspaceFiles(updatedFilesData.files);
      }
      setCommandOutput('Workspace refreshed & LSP diagnostic servers re-synced.');
    } catch (e) {
      console.error('Refresh error:', e);
    }
  };

  // Load and scan project directory path
  const handleLoadDirectoryPath = async (directoryPath: string) => {
    try {
      const res = await fetch('/api/workspace/load-directory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directoryPath, sessionId: activeSessionId })
      });
      const data = await res.json();
      if (data.success && data.files) {
        setWorkspaceFiles(data.files);
        const firstFile = Object.keys(data.files)[0] || 'readme.md';
        setActiveFilePath(firstFile);

        // Update active session workspace files and log message
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id === activeSessionId) {
              const dirMsg: ChatMessage = {
                id: `msg-dir-${Date.now()}`,
                sender: 'system',
                content: `📁 Switched active project directory to: "${data.activeDirectory}" (${data.fileCount} files scanned and active).`,
                timestamp: new Date().toLocaleTimeString()
              };
              return {
                ...s,
                isolatedWorkspaceFiles: data.files,
                messages: [...s.messages, dirMsg]
              };
            }
            return s;
          })
        );
        return { success: true, fileCount: data.fileCount, activeDirectory: data.activeDirectory };
      }
      return {
        success: false,
        isLocalMachinePath: data.isLocalMachinePath || false,
        message: data.message || 'Failed to load directory path',
        error: data.message || 'Directory path not found on server'
      };
    } catch (err) {
      console.error('Directory load error:', err);
      return { success: false, error: String(err) };
    }
  };

  // Complete Factory Reset
  const handleFactoryResetApp = () => {
    const defaultSession: AgentSession = {
      id: 'session-default-1',
      name: 'Main Refactoring Agent',
      description: 'Primary software engineering agent handling API implementation & LSP verification.',
      status: 'idle',
      modelId: DEFAULT_LOCAL_MODEL.id,
      createdAt: new Date().toLocaleTimeString(),
      updatedAt: new Date().toLocaleTimeString(),
      messages: [
        {
          id: 'msg-welcome',
          sender: 'agent',
          content: `DevForge Studio factory reset complete! 🚀\n\nWorkspace files, sessions, and chat logs restored to initial state.`,
          timestamp: new Date().toLocaleTimeString()
        }
      ],
      progress: 100,
      logs: ['Application factory reset completed.'],
      currentLspDiagnostics: [],
      isolatedWorkspaceFiles: { ...DEFAULT_WORKSPACE_FILES }
    };

    setSessions([defaultSession]);
    setActiveSessionId('session-default-1');
    setWorkspaceFiles({ ...DEFAULT_WORKSPACE_FILES });
    setActiveFilePath('README.md');
    setCommandOutput('');
    fetchLspDiagnostics();
  };

  // Auto Fix LSP diagnostic via agent dispatch
  const handleFixLspDiagnostic = (diag: LSPDiagnostic) => {
    const prompt = `LSP Diagnostic Error in ${diag.filePath} line ${diag.line}: "${diag.message}". Code: ${diag.code}. Please fix this diagnostic error cleanly using language server recommendations.`;
    handleSendMessage(prompt, []);
    setActiveTab('chat');
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500/30 selection:text-white">
      {/* Top Navigation Header */}
      <Header
        currentModel={currentModel}
        availableModels={availableModels}
        onSelectModel={setCurrentModel}
        isScanningModels={isScanningModels}
        taskMode={taskMode}
        onTaskModeChange={setTaskMode}
        writePolicy={writePolicy}
        onWritePolicyChange={setWritePolicy}
        systemProfile={systemProfile}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={(id) => setActiveSessionId(id)}
        onNewSession={handleNewSession}
        onOpenModelModal={() => setIsModelModalOpen(true)}
        onOpenLspModal={() => setActiveTab('lsp')}
        onOpenSettingsModal={() => setIsSettingsModalOpen(true)}
        prerequisitesReady={prerequisitesReady}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onRefreshApp={handleRefreshApp}
        onFactoryResetApp={handleFactoryResetApp}
      />

      {/* Prerequisites Banner */}
      <PrerequisitesBanner
        prerequisites={prerequisites}
        lspServers={lspServers}
        modelsDetected={availableModels.length}
        isScanningModels={isScanningModels}
        acceleration={systemProfile?.acceleration}
        totalVramMB={systemProfile?.totalVramMB ?? 0}
      />

      {/* Main Container */}
      <main className="flex-1 w-full p-3 sm:p-5 flex flex-col space-y-4">
        {/* Multi-Session Manager Tabs */}
        <MultiSessionManager
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={(id) => setActiveSessionId(id)}
          onNewSession={handleNewSession}
          onDeleteSession={handleDeleteSession}
          onClearAllOtherSessions={() => {
            const current = sessions.find(s => s.id === activeSessionId) || sessions[0];
            setSessions([current]);
          }}
          onStopAgent={handleStopAgent}
          onPauseAgent={handlePauseAgent}
          onResumeAgent={handleResumeAgent}
          onRenameAgent={handleRenameAgent}
          onStopAllAgents={handleStopAllAgents}
          onPauseAllAgents={handlePauseAllAgents}
        />

        {/* Tab Views */}
        {activeTab === 'chat' && (
          <div className="flex flex-col xl:flex-row gap-0 w-full items-stretch">
            <div className="flex-1 min-w-0 flex flex-col" style={workspaceWidth !== null ? { maxWidth: `calc(100% - ${workspaceWidth}px)` } : undefined}>
              {activeTab === 'chat' && !isScanningModels && availableModels.length === 0 && (
                <FirstRunGuide
                  onRescan={() => scanAndDetectLocalModels()}
                  isScanning={isScanningModels}
                  onOpenWizard={() => setIsOnboardingOpen(true)}
                />
              )}              <ChatInterface
                messages={activeSession.messages}
                onSendMessage={handleSendMessage}
                isProcessing={isAgentRunning}
                onQuickAction={handleQuickAction}
                onClearChat={handleClearChat}
                onDeleteMessage={handleDeleteMessage}
                activeSessionName={activeSession.name}
                agentStatus={activeSession.status}
                onStopAgent={() => handleStopAgent(activeSessionId)}
                onPauseAgent={() => handlePauseAgent(activeSessionId)}
                onResumeAgent={() => handleResumeAgent(activeSessionId)}
                draftToInject={chatDraft}
              />
            </div>

            {/* Draggable splitter — drag to resize chat vs workspace */}
            <div
              className="hidden xl:flex shrink-0 w-2 cursor-col-resize items-center justify-center group select-none"
              onMouseDown={handleSplitterMouseDown}
              title="Drag to resize"
            >
              <div className="h-full w-px bg-slate-800 group-hover:bg-emerald-500 transition-colors" />
            </div>

            {/* Workspace sidebar — load/import folders without leaving the chat */}
            <div className="w-full xl:w-[460px] shrink-0 min-w-[320px]" style={workspaceWidth !== null ? { width: workspaceWidth } : undefined}>
              <CodeWorkspace
                sessionId={activeSessionId}
                files={workspaceFiles}
                activeFilePath={activeFilePath}
                onSelectFile={(path) => setActiveFilePath(path)}
                onSaveFile={handleSaveFile}
                onDeleteFile={handleDeleteFile}
                onRefreshWorkspace={handleRefreshApp}
                onLoadDirectoryPath={handleLoadDirectoryPath}
                diagnostics={diagnostics}
                onExecuteCommand={handleExecuteCommand}
                commandOutput={commandOutput}
                isExecuting={isExecuting}
                targetFolderPath={targetFolderPath}
                onTargetFolderPathChange={setTargetFolderPath}
              />
            </div>
          </div>
        )}

        {activeTab === 'graph' && (
          <>
          <LiveDashboard
            planSteps={dashPlan}
            toolFeed={dashToolFeed}
            filesTouched={dashFiles}
            iterStats={dashIterStats}
            contextUsage={contextUsage}
          />
          <AgentGraphVisualizer
            nodes={
              isAgentRunning && livePlan.length > 0
                ? ([
                    { id: 'analyze_context', label: 'Analyze Context & Prompt', status: 'success' },
                    ...livePlan.map((item, i) => {
                      const activeIdx = Math.min(liveIteration, livePlan.length);
                      return {
                        id: `plan-${i}`,
                        label: item.length > 70 ? item.slice(0, 67) + '…' : item,
                        status: i < activeIdx ? 'success' : i === activeIdx ? 'running' : 'pending'
                      };
                    }),
                    { id: 'complete', label: 'Final Delivery', status: 'pending' }
                  ] as LangGraphNodeState[])
                : activeSession.messages[activeSession.messages.length - 1]?.graphState || [
                    { id: 'analyze_context', label: '1. Analyze Context & Attachments', status: 'success', durationMs: 42 },
                    { id: 'lsp_check', label: '2. Pre-Execution LSP Diagnostics', status: 'success', durationMs: 85 },
                    { id: 'plan_agent', label: '3. LangGraph Agent Planning', status: 'success', durationMs: 120 },
                    { id: 'execute_tools', label: '4. Tool Execution & Code Edits', status: 'success', durationMs: 190 },
                    { id: 'verify_lsp', label: '5. Verification LSP Re-Check', status: 'success', durationMs: 76 },
                    { id: 'self_correction', label: '6. Self-Correction Loop', status: 'skipped' },
                    { id: 'complete', label: '7. Final Delivery', status: 'success', durationMs: 34 }
                  ]
            }
            currentSessionName={activeSession.name}
            contextUsage={contextUsage}
          />
          </>
        )}

        {activeTab === 'lsp' && (
          <LspPanel
            servers={lspServers}
            diagnostics={diagnostics}
            onScanDiagnostics={fetchLspDiagnostics}
            onFixWithAgent={handleFixLspDiagnostic}
          />
        )}

        {activeTab === 'memory' && (
          <MemoryInspector
            longTermMemories={longTermMemories}
            shortTermMemory={{
              activeSessionId,
              activeFilePath,
              activeDirectoryPath: 'DevForge Workspace',
              totalWorkspaceFiles: Object.keys(workspaceFiles).length,
              recentActionsCount: activeSession?.messages.filter((m) => m.actions && m.actions.length > 0).length || 0,
              activeDiagnosticErrorsCount: diagnostics.filter((d) => d.severity === 'error').length,
              lastExecutedCommand: commandOutput ? commandOutput.split('\n')[0] : undefined,
              turnCount: activeSession?.messages.length || 0,
              currentObjective: activeSession?.assignedTask || 'Autonomous Code Modification & Intelligence'
            }}
            onAddMemory={handleAddMemory}
            onDeleteMemory={handleDeleteMemory}
            onClearAllMemories={handleClearAllMemories}
            onAutoExtractMemories={handleAutoExtractMemories}
            activeFilePath={activeFilePath}
            promptContextPreview={`=== PERMANENT LONG-TERM PROJECT MEMORIES & PREFERENCES (LTM) ===
${longTermMemories.map((m) => `• [${m.category.toUpperCase()}] ${m.key}: ${m.value}`).join('\n')}
=================================================================

=== SHORT-TERM WORKING MEMORY & CONTEXT (STM) ===
• Active Session ID: ${activeSessionId}
• Active Workspace File Focus: ${activeFilePath || 'Root Directory'}
• Scanned Workspace Files: ${Object.keys(workspaceFiles).length} files active
• Chat Turns Memory Window: ${activeSession?.messages.length || 0} messages in history
• Active Diagnostic Errors: ${diagnostics.filter((d) => d.severity === 'error').length} issues
==================================================`}
          />
        )}

        {activeTab === 'checkpoints' && (
          <CheckpointTimeline
            sessionId={activeSessionId}
            onReverted={() => handleRefreshApp()}
          />
        )}

        {activeTab === 'stats' && <StatsDashboard />}

        {activeTab === 'board' && (
          <TaskBoard
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={(id) => {
              setActiveSessionId(id);
              setActiveTab('chat');
            }}
            onStopAgent={handleStopAgent}
            onPauseAgent={handlePauseAgent}
            onResumeAgent={handleResumeAgent}
          />
        )}

        {activeTab === 'docs' && <DocsPanel />}
      </main>


      {/* Modals */}
      {pendingReview && (
        <EditReviewModal
          review={pendingReview}
          onDecide={(accepted) => {
            fetch('/api/agent/review', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId: pendingReview.runId, accepted })
            }).catch(() => {});
            setPendingReview(null);
          }}
        />
      )}
      <ModelSelectorModal
        isOpen={isModelModalOpen}
        onClose={() => setIsModelModalOpen(false)}
        currentModel={currentModel}
        availableModels={availableModels}
        onSelectModel={(model) => setCurrentModel(model)}
        onScanLocalModels={scanAndDetectLocalModels}
        isScanning={isScanningModels}
        onAddManualModel={handleAddManualModel}
      />

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        settings={settings}
        onUpdateSettings={(newSettings) => setSettings(newSettings)}
        onFactoryResetApp={handleFactoryResetApp}
        onOpenProjectRules={() => {
          setIsSettingsModalOpen(false);
          setIsProjectRulesOpen(true);
        }}
      />

      <ProjectRulesModal
        isOpen={isProjectRulesOpen}
        onClose={() => setIsProjectRulesOpen(false)}
        sessionId={activeSessionId}
      />

      <OnboardingWizard
        isOpen={isOnboardingOpen}
        onClose={closeOnboarding}
        onRescanModels={() => scanAndDetectLocalModels()}
        onPickSampleTask={(prompt) => setChatDraft({ text: prompt, id: Date.now() })}
      />
    </div>
  );
}
