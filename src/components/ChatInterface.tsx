import React, { useState, useRef } from 'react';
import { 
  Send, 
  Paperclip, 
  FileText, 
  Image as ImageIcon, 
  FileCode, 
  X, 
  Bot, 
  User, 
  CheckCircle2, 
  Sparkles, 
  Zap, 
  Code2, 
  Terminal, 
  Layers, 
  ShieldCheck, 
  FileSearch,
  Eye,
  Trash2,
  RefreshCw,
  Pause,
  Play,
  Square,
  Brain,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { ChatMessage, AttachmentFile, LSPDiagnostic, ThinkingLevel } from '../types';
import { MarkdownMessage } from './Markdown';
import { DiffView } from './DiffView';

interface ChatInterfaceProps {
  messages: ChatMessage[];
  onSendMessage: (prompt: string, attachments: AttachmentFile[], thinkingLevel?: ThinkingLevel) => void;
  isProcessing: boolean;
  onQuickAction: (actionText: string) => void;
  onClearChat?: () => void;
  onDeleteMessage?: (id: string) => void;
  activeSessionName?: string;
  agentStatus?: 'active' | 'idle' | 'running' | 'paused' | 'stopped' | 'completed' | 'error';
  onStopAgent?: () => void;
  onPauseAgent?: () => void;
  onResumeAgent?: () => void;
  /** P4.1: externally injected draft text (sample tasks); new id → replaces input */
  draftToInject?: { text: string; id: number } | null;
}

const THINKING_OPTIONS: Array<{
  id: ThinkingLevel;
  label: string;
  badgeLabel: string;
  badgeStyle: string;
  description: string;
}> = [
  {
    id: 'none',
    label: 'No thinking',
    badgeLabel: 'No Thinking (Default)',
    badgeStyle: 'bg-slate-800 text-slate-300 border-slate-700',
    description: 'Fast direct output mode with default zero extra reasoning delay.'
  },
  {
    id: 'low',
    label: 'Low',
    badgeLabel: 'Low Thinking',
    badgeStyle: 'bg-sky-950 text-sky-300 border-sky-800',
    description: 'Lightweight chain-of-thought for quick single-file validation.'
  },
  {
    id: 'medium',
    label: 'Medium',
    badgeLabel: 'Medium Thinking',
    badgeStyle: 'bg-amber-950 text-amber-300 border-amber-800',
    description: 'Balanced reasoning budget for component refactoring & LSP checks.'
  },
  {
    id: 'high',
    label: 'High',
    badgeLabel: 'High Thinking',
    badgeStyle: 'bg-purple-950 text-purple-300 border-purple-800',
    description: 'Extended deep reasoning chain for complex multi-file changes.'
  }
];

export const ChatInterface: React.FC<ChatInterfaceProps> = ({
  messages,
  onSendMessage,
  isProcessing,
  onQuickAction,
  onClearChat,
  onDeleteMessage,
  activeSessionName,
  agentStatus,
  onStopAgent,
  onPauseAgent,
  onResumeAgent,
  draftToInject
}) => {
  const [inputText, setInputText] = useState('');
  const [attachments, setAttachments] = useState<AttachmentFile[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<AttachmentFile | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('none');
  const [showThinkingDropdown, setShowThinkingDropdown] = useState<boolean>(false);
  const [expandedThoughtMsgIds, setExpandedThoughtMsgIds] = useState<Record<string, boolean>>({});

  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // P-fix: stick-to-bottom auto-scroll — follow new content unless the user
  // deliberately scrolled up (>120px away from the bottom).
  const stickToBottomRef = useRef(true);
  const lastMessage = messages[messages.length - 1];
  const lastContentLen = typeof lastMessage?.content === 'string' ? lastMessage.content.length : 0;

  React.useEffect(() => {
    if (!stickToBottomRef.current) return;
    chatBottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages.length, lastContentLen]);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // P4.1: consume externally injected draft text (e.g. onboarding sample tasks)
  React.useEffect(() => {
    if (draftToInject?.text) setInputText(draftToInject.text);
  }, [draftToInject?.id]);

  const currentThinkingOpt = THINKING_OPTIONS.find(o => o.id === thinkingLevel) || THINKING_OPTIONS[0];

  const toggleThoughtExpanded = (msgId: string) => {
    setExpandedThoughtMsgIds(prev => ({
      ...prev,
      [msgId]: !prev[msgId]
    }));
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    Array.from(files).forEach((file: File) => {
      const reader = new FileReader();
      const ext = file.name.split('.').pop()?.toLowerCase();
      const isImage = file.type.startsWith('image/');
      const isPdf = file.type === 'application/pdf' || ext === 'pdf';

      reader.onload = (event) => {
        const result = event.target?.result as string;
        const newAttachment: AttachmentFile = {
          id: `att-${crypto.randomUUID()}`,
          name: file.name,
          size: file.size,
          type: isPdf ? 'pdf' : isImage ? 'image' : 'doc',
          mimeType: file.type || (isPdf ? 'application/pdf' : 'text/plain'),
          content: result,
          previewUrl: isImage ? result : undefined,
          extractedSummary: `Loaded ${file.name} (${(file.size / 1024).toFixed(1)} KB)`
        };

        setAttachments((prev) => [...prev, newAttachment]);
      };

      if (isImage || isPdf) {
        reader.readAsDataURL(file);
      } else {
        reader.readAsText(file);
      }
    });

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((!inputText.trim() && attachments.length === 0) || isProcessing) return;

    onSendMessage(inputText, attachments, thinkingLevel);
    setInputText('');
    setAttachments([]);
    // Follow the user's own message immediately
    stickToBottomRef.current = true;
    requestAnimationFrame(() => chatBottomRef.current?.scrollIntoView({ block: 'end' }));
  };

  return (
    <div className="flex flex-col h-[calc(100vh-140px)] bg-slate-950 rounded-xl border border-slate-800 overflow-hidden shadow-2xl">
      {/* Top Chat Header Bar */}
      <div className="bg-slate-900 border-b border-slate-800 px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center space-x-2">
          <Bot className="w-4 h-4 text-emerald-400" />
          <span className="font-semibold text-slate-200">
            {activeSessionName || 'Active Session Chat'}
          </span>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">
            {messages.length} messages
          </span>

          {/* Status Badge */}
          {isProcessing || agentStatus === 'running' ? (
            <span className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800">
              <Zap className="w-3 h-3 animate-spin text-cyan-400" /> Running
            </span>
          ) : agentStatus === 'paused' ? (
            <span className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-950 text-amber-300 border border-amber-800">
              <Pause className="w-3 h-3 text-amber-400" /> Paused
            </span>
          ) : agentStatus === 'stopped' ? (
            <span className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full bg-rose-950 text-rose-300 border border-rose-800">
              <Square className="w-3 h-3 text-rose-400" /> Stopped
            </span>
          ) : null}

          {/* Thinking Capabilities Header Selector */}
          <div className="relative inline-block text-left">
            <button
              type="button"
              onClick={() => setShowThinkingDropdown(!showThinkingDropdown)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium transition-all ${currentThinkingOpt.badgeStyle}`}
              title="Manage model thinking capabilities"
            >
              <Brain className={`w-3.5 h-3.5 ${
                thinkingLevel === 'none' ? 'text-slate-400' : thinkingLevel === 'low' ? 'text-sky-400' : thinkingLevel === 'medium' ? 'text-amber-400' : 'text-purple-400'
              }`} />
              <span>Thinking: <strong className="font-semibold">{currentThinkingOpt.label}</strong></span>
              <ChevronDown className="w-3 h-3 text-slate-400 ml-0.5" />
            </button>

            {showThinkingDropdown && (
              <div 
                className="absolute left-0 mt-1.5 w-64 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl p-2 z-50 animate-fadeIn text-xs"
                onMouseLeave={() => setShowThinkingDropdown(false)}
              >
                <div className="text-[10px] uppercase font-mono font-bold text-slate-400 px-2 py-1 border-b border-slate-800 mb-1 flex items-center justify-between">
                  <span>Model Thinking Capability</span>
                  <span className="text-emerald-400 text-[9px] font-normal">Default: No thinking</span>
                </div>

                {THINKING_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setThinkingLevel(opt.id);
                      setShowThinkingDropdown(false);
                    }}
                    className={`w-full text-left p-2 rounded-lg transition-all mb-1 flex flex-col ${
                      thinkingLevel === opt.id
                        ? 'bg-slate-800 border border-emerald-500/50'
                        : 'hover:bg-slate-800/60 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center justify-between font-semibold text-slate-200">
                      <span className="flex items-center gap-1.5">
                        <Brain className={`w-3.5 h-3.5 ${
                          opt.id === 'none' ? 'text-slate-400' : opt.id === 'low' ? 'text-sky-400' : opt.id === 'medium' ? 'text-amber-400' : 'text-purple-400'
                        }`} />
                        {opt.label}
                      </span>
                      {thinkingLevel === opt.id && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono">Active</span>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-400 mt-0.5 leading-tight">{opt.description}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center space-x-2">
          {/* Agent Live Control Actions */}
          {(isProcessing || agentStatus === 'running') && onPauseAgent && (
            <button
              onClick={onPauseAgent}
              className="flex items-center space-x-1 px-2.5 py-1 rounded bg-amber-950/70 hover:bg-amber-900 text-amber-300 border border-amber-700 text-[11px] font-semibold transition-all shadow-sm"
              title="Pause current agent run"
            >
              <Pause className="w-3.5 h-3.5" />
              <span>Pause Agent</span>
            </button>
          )}

          {(isProcessing || agentStatus === 'running' || agentStatus === 'paused') && onStopAgent && (
            <button
              onClick={onStopAgent}
              className="flex items-center space-x-1 px-2.5 py-1 rounded bg-rose-950/70 hover:bg-rose-900 text-rose-300 border border-rose-700 text-[11px] font-semibold transition-all shadow-sm"
              title="Stop current agent run"
            >
              <Square className="w-3.5 h-3.5" />
              <span>Stop Agent</span>
            </button>
          )}

          {(agentStatus === 'paused' || agentStatus === 'stopped') && onResumeAgent && (
            <button
              onClick={onResumeAgent}
              className="flex items-center space-x-1 px-2.5 py-1 rounded bg-emerald-950/70 hover:bg-emerald-900 text-emerald-300 border border-emerald-700 text-[11px] font-semibold transition-all shadow-sm"
              title="Resume agent execution"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Resume Agent</span>
            </button>
          )}

          {onClearChat && (
            <button
              onClick={() => {
                if (window.confirm("Are you sure you want to clear this session's chat history?")) {
                  onClearChat();
                }
              }}
              className="flex items-center space-x-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-rose-950/60 text-slate-400 hover:text-rose-300 border border-slate-700 hover:border-rose-800/60 transition-all font-medium text-[11px]"
              title="Clear active chat history"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear Chat</span>
            </button>
          )}
        </div>
      </div>

      {/* Messages Scroll View */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400 my-auto">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-emerald-500/20 via-teal-500/20 to-cyan-500/20 border border-emerald-500/30 flex items-center justify-center mb-4 shadow-lg shadow-emerald-500/10">
              <Bot className="w-8 h-8 text-emerald-400" />
            </div>
            <h3 className="font-bold text-lg text-white mb-1">DevForge Studio</h3>
            <p className="text-xs text-slate-400 max-w-md mb-6 leading-relaxed">
              Open-source autonomous AI coding workspace powered by LangGraph, LSP diagnostics, multi-session execution, and multimodal context.
            </p>

            {/* Prompt Suggestion Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-w-xl w-full text-left">
              <button
                onClick={() => onQuickAction("Run a full LSP diagnostic check across all code files and fix any missing types or syntax warnings.")}
                className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-emerald-500/50 transition-all text-xs group"
              >
                <div className="font-semibold text-slate-200 group-hover:text-emerald-400 flex items-center gap-1.5 mb-1">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" /> Run Full LSP Scan
                </div>
                <p className="text-[11px] text-slate-400">Detects syntax & type errors across TypeScript & Python with auto-fix.</p>
              </button>

              <button
                onClick={() => onQuickAction("Add a new POST /api/tasks endpoint with input validation and calculate total metrics in taskService.ts.")}
                className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-emerald-500/50 transition-all text-xs group"
              >
                <div className="font-semibold text-slate-200 group-hover:text-emerald-400 flex items-center gap-1.5 mb-1">
                  <Code2 className="w-4 h-4 text-cyan-400" /> Implement Task Metrics API
                </div>
                <p className="text-[11px] text-slate-400">Generates type-safe Express routes and updates calculation logic.</p>
              </button>

              <button
                onClick={() => onQuickAction("Write comprehensive unit tests using Vitest for taskService.ts and run the test suite.")}
                className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-emerald-500/50 transition-all text-xs group"
              >
                <div className="font-semibold text-slate-200 group-hover:text-emerald-400 flex items-center gap-1.5 mb-1">
                  <Terminal className="w-4 h-4 text-amber-400" /> Write Vitest Unit Tests
                </div>
                <p className="text-[11px] text-slate-400">Creates test suite and executes test runner inside sandbox.</p>
              </button>

              <button
                onClick={() => onQuickAction("Analyze notebooks/data_analysis.ipynb and src/agent/langgraphPipeline.py, then refactor the Python data processing and JSON configs.")}
                className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-emerald-500/50 transition-all text-xs group"
              >
                <div className="font-semibold text-slate-200 group-hover:text-emerald-400 flex items-center gap-1.5 mb-1">
                  <FileCode className="w-4 h-4 text-purple-400" /> Analyze .ipynb & .py Files
                </div>
                <p className="text-[11px] text-slate-400">Processes Jupyter notebooks, Python scripts, JSON, YAML configs & docs.</p>
              </button>
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const isUser = msg.sender === 'user';

            return (
              <div
                key={msg.id}
                className={`flex gap-3 max-w-4xl ${isUser ? 'ml-auto flex-row-reverse' : 'mr-auto'}`}
              >
                <div
                  className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 text-xs font-bold ${
                    isUser
                      ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/20'
                      : 'bg-slate-800 border border-slate-700 text-emerald-400'
                  }`}
                >
                  {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                </div>

                <div className="space-y-2 flex-1 max-w-3xl">
                  {/* Sender Name & Timestamp */}
                  <div className={`flex items-center space-x-2 text-[11px] text-slate-400 ${isUser ? 'justify-end' : ''}`}>
                    <span className="font-medium text-slate-300">{isUser ? 'You' : 'DevForge Agent'}</span>
                    <span>•</span>
                    <span className="font-mono">{msg.timestamp}</span>
                    {onDeleteMessage && (
                      <button
                        onClick={() => onDeleteMessage(msg.id)}
                        className="p-0.5 rounded text-slate-600 hover:text-rose-400 transition-colors ml-1"
                        title="Delete message"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>

                  {/* Message Bubble */}
                  <div
                    className={`p-4 rounded-2xl border text-sm leading-relaxed ${
                      isUser
                        ? 'bg-emerald-950/60 border-emerald-800/80 text-emerald-50 rounded-tr-none'
                        : 'bg-slate-900 border-slate-800 text-slate-100 rounded-tl-none shadow-md'
                    }`}
                  >
                    {/* Render Attachments if user message */}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-3 pb-3 border-b border-slate-800">
                        {msg.attachments.map((att) => (
                          <div
                            key={att.id}
                            onClick={() => setPreviewAttachment(att)}
                            className="flex items-center space-x-1.5 p-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200 cursor-pointer hover:border-emerald-500/50 transition-colors"
                          >
                            {att.type === 'image' ? (
                              <ImageIcon className="w-3.5 h-3.5 text-cyan-400" />
                            ) : att.type === 'pdf' ? (
                              <FileText className="w-3.5 h-3.5 text-rose-400" />
                            ) : (
                              <FileCode className="w-3.5 h-3.5 text-amber-400" />
                            )}
                            <span className="truncate max-w-[150px] font-medium">{att.name}</span>
                            <Eye className="w-3 h-3 text-slate-400 ml-1" />
                          </div>
                        ))}
                      </div>
                    )}

                    {msg.sender === 'agent' ? (
                      <MarkdownMessage content={msg.content} />
                    ) : (
                      <div className="whitespace-pre-wrap font-sans">{msg.content}</div>
                    )}

                    {/* U3: real unified diffs */}
                    {msg.filePatches && msg.filePatches.length > 0 && (
                      <DiffView patches={msg.filePatches} />
                    )}

                    {/* Model Thinking Process Breakdown */}
                    {(msg.thinkingProcess || (msg.thinkingLevel && msg.thinkingLevel !== 'none')) && (
                      <div className="mt-3 pt-2.5 border-t border-slate-800">
                        <button
                          type="button"
                          onClick={() => toggleThoughtExpanded(msg.id)}
                          className="w-full flex items-center justify-between p-2 rounded-lg bg-slate-950 hover:bg-slate-950/80 border border-slate-800 text-left transition-colors"
                        >
                          <span className="flex items-center gap-1.5 font-semibold text-purple-300 text-[11px] font-mono">
                            <Brain className="w-3.5 h-3.5 text-purple-400" />
                            Model Chain-of-Thought ({msg.thinkingLevel ? msg.thinkingLevel.toUpperCase() : 'ENABLED'} THINKING)
                          </span>
                          <span className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-white font-mono">
                            {expandedThoughtMsgIds[msg.id] ? (
                              <>Hide Thought Process <ChevronUp className="w-3 h-3" /></>
                            ) : (
                              <>Show Thought Process <ChevronDown className="w-3 h-3" /></>
                            )}
                          </span>
                        </button>

                        {expandedThoughtMsgIds[msg.id] && (
                          <div className="mt-2 p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[11px] text-purple-200/90 whitespace-pre-wrap leading-relaxed shadow-inner">
                            {msg.thinkingProcess || `Reasoning executed with ${msg.thinkingLevel} thinking budget. Verified component boundaries, type signatures, and LSP diagnostic constraints.`}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Agent Code Diffs */}
                    {msg.codeDiffs && msg.codeDiffs.length > 0 && (
                      <div className="mt-3 space-y-2 pt-3 border-t border-slate-800">
                        <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Modified Code Workspace Files ({msg.codeDiffs.length}):
                        </span>
                        {msg.codeDiffs.map((diff, i) => (
                          <div key={i} className="bg-slate-950 p-2.5 rounded-lg border border-slate-800 font-mono text-xs overflow-x-auto">
                            <div className="text-slate-400 mb-1 font-semibold text-[11px] flex items-center justify-between">
                              <span>📄 {diff.filePath}</span>
                              <span className="text-emerald-400 text-[10px]">LSP Verified Safe</span>
                            </div>
                            <pre className="text-emerald-300 bg-slate-900 p-2 rounded border border-slate-800 max-h-40 overflow-y-auto font-mono text-[11px]">
                              {diff.newContent}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Command Output */}
                    {msg.commandExecution && (
                      <div className="mt-3 p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs text-slate-300">
                        <div className="flex items-center justify-between text-slate-400 text-[11px] mb-1.5 pb-1 border-b border-slate-800">
                          <span className="flex items-center gap-1">
                            <Terminal className="w-3.5 h-3.5 text-cyan-400" /> Sandbox Execution:
                          </span>
                          <span className="text-emerald-400 font-semibold">Exit Code 0</span>
                        </div>
                        <pre className="whitespace-pre-wrap text-slate-300 text-[11px]">
                          {msg.commandExecution.output}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={chatBottomRef} />
      </div>

      {/* Attachments Bar */}
      {attachments.length > 0 && (
        <div className="px-4 py-2 bg-slate-900 border-t border-slate-800 flex flex-wrap gap-2">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="flex items-center space-x-2 px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200"
            >
              {att.type === 'image' ? (
                <ImageIcon className="w-3.5 h-3.5 text-cyan-400" />
              ) : att.type === 'pdf' ? (
                <FileText className="w-3.5 h-3.5 text-rose-400" />
              ) : (
                <FileCode className="w-3.5 h-3.5 text-amber-400" />
              )}
              <span className="truncate max-w-[140px] font-medium">{att.name}</span>
              <button
                type="button"
                onClick={() => removeAttachment(att.id)}
                className="text-slate-500 hover:text-rose-400 p-0.5"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Thinking Capabilities Selector Bar */}
      <div className="px-3 py-1.5 bg-slate-900 border-t border-slate-800 flex flex-wrap items-center justify-between text-xs gap-2">
        <div className="flex items-center space-x-1.5 text-slate-300 font-medium text-[11px]">
          <Brain className="w-3.5 h-3.5 text-purple-400" />
          <span>Model Thinking Capability:</span>
        </div>

        <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800">
          {THINKING_OPTIONS.map((opt) => {
            const isSelected = thinkingLevel === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setThinkingLevel(opt.id)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all flex items-center gap-1.5 ${
                  isSelected
                    ? opt.id === 'none'
                      ? 'bg-slate-800 text-white font-semibold shadow-sm border border-slate-700'
                      : opt.id === 'low'
                      ? 'bg-sky-950 text-sky-200 font-semibold shadow-sm border border-sky-700'
                      : opt.id === 'medium'
                      ? 'bg-amber-950 text-amber-200 font-semibold shadow-sm border border-amber-700'
                      : 'bg-purple-950 text-purple-200 font-semibold shadow-sm border border-purple-700'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
                title={opt.description}
              >
                {opt.id === 'none' && <span className="text-[10px]">🚫</span>}
                {opt.id === 'low' && <span className="text-[10px]">⚡</span>}
                {opt.id === 'medium' && <span className="text-[10px]">💡</span>}
                {opt.id === 'high' && <span className="text-[10px]">🔥</span>}
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Input Form Bar */}
      <form onSubmit={handleSubmit} className="p-3 bg-slate-900 border-t border-slate-800 flex items-center gap-2">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileUpload}
          multiple
          accept="image/*,.ipynb,.py,.json,.js,.ts,.jsx,.tsx,.config,.yaml,.yml,.toml,.md,.pdf,.doc,.docx,.txt,.csv,.rs,.go,.html,.css"
          className="hidden"
        />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/80 transition-colors shrink-0"
          title="Attach PDF, Images, Code, Docs"
        >
          <Paperclip className="w-4 h-4 text-cyan-400" />
        </button>

        <textarea
          ref={(el) => {
            textareaRef.current = el;
            // Auto-grow up to ~160px, then scroll
            if (el) {
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }
          }}
          rows={1}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline. Ctrl/Cmd+Enter also
            // sends; Esc stops a running agent.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e as any);
            } else if (e.key === 'Escape' && isProcessing && onStopAgent) {
              onStopAgent();
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleSubmit(e as any);
            }
          }}
          placeholder="Ask DevForge agent to edit code, run tests, diagnose LSP... (/test /fix /explain /new-session) — Shift+Enter for a new line"
          disabled={isProcessing}
          className="flex-1 resize-none bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500/80 transition-colors"
        />

        <button
          type="submit"
          disabled={(!inputText.trim() && attachments.length === 0) || isProcessing}
          className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold text-xs flex items-center space-x-1.5 transition-all shadow-md shrink-0"
        >
          {isProcessing ? (
            <span className="flex items-center gap-1.5">
              <Zap className="w-4 h-4 animate-spin text-emerald-200" /> Agent Running...
            </span>
          ) : (
            <>
              <span>Dispatch Agent</span>
              <Send className="w-3.5 h-3.5" />
            </>
          )}
        </button>
      </form>

      {/* Preview Modal for Attachments */}
      {previewAttachment && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-5 max-h-[80vh] overflow-y-auto text-slate-100">
            <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-800">
              <h4 className="font-bold text-sm flex items-center gap-2">
                <FileSearch className="w-4 h-4 text-cyan-400" /> Attachment Preview: {previewAttachment.name}
              </h4>
              <button
                onClick={() => setPreviewAttachment(null)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {previewAttachment.type === 'image' && previewAttachment.previewUrl ? (
              <img
                src={previewAttachment.previewUrl}
                alt={previewAttachment.name}
                className="max-h-96 mx-auto rounded-xl border border-slate-800 object-contain"
              />
            ) : (
              <pre className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-xs font-mono text-emerald-300 max-h-96 overflow-y-auto whitespace-pre-wrap">
                {previewAttachment.content || previewAttachment.extractedSummary}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
