export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high';

export type TaskMode =
  | 'general'
  | 'coding'
  | 'debugging'
  | 'testing'
  | 'test_creation'
  | 'refactoring'
  | 'app_development'
  | 'complex_task';

export interface SystemProfile {
  platform: string;
  cpuModel: string;
  cpuCores: number;
  totalRamMB: number;
  availableRamMB: number;
  gpus: Array<{ vendor: string; name: string; vramMB: number }>;
  totalVramMB: number;
  recommendedContextTokens: number;
  acceleration: 'cuda' | 'metal' | 'rocm' | 'cpu';
}

export interface AIModel {
  id: string;
  name: string;
  provider: 'DeepSeek' | 'Meta Llama' | 'Qwen' | 'Anthropic' | 'Ollama / Local' | 'Local';
  isOpenSource: boolean;
  isFree: boolean;
  contextWindow: string;
  supportsVision: boolean;
  supportsPdf: boolean;
  description: string;
  recommendedFor: string;
  endpoint?: string;
}

export interface AttachmentFile {
  id: string;
  name: string;
  size: number;
  type: string; // 'pdf' | 'image' | 'doc' | 'code' | 'json' | 'csv' | 'other'
  content?: string; // Text content or Base64 data URL
  mimeType: string;
  previewUrl?: string;
  extractedSummary?: string;
}

export interface LSPDiagnostic {
  id: string;
  filePath: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  source: 'ts-server' | 'pyright' | 'eslint' | 'rust-analyzer' | 'gopls' | 'css-lsp';
  fixable: boolean;
  suggestedFix?: string;
}

export interface LSPServerStatus {
  id: string;
  name: string;
  language: string;
  extensions: string[];
  status: 'running' | 'starting' | 'idle' | 'off';
  activeDiagnosticsCount: number;
  version: string;
}

export interface WorkspaceFile {
  path: string;
  name: string;
  content: string;
  language: string;
  isModified?: boolean;
  originalContent?: string;
}

export type LangGraphNodeId = 
  | 'analyze_context'
  | 'lsp_check'
  | 'plan_agent'
  | 'execute_tools'
  | 'verify_lsp'
  | 'self_correction'
  | 'complete';

export interface LangGraphNodeState {
  /** Stable ids like 'analyze_context' or dynamic ones like 'plan-2' */
  id: string;
  label: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  message?: string;
  durationMs?: number;
  outputDetails?: Record<string, any>;
}

export interface AgentAction {
  type: 'read_file' | 'write_file' | 'run_lsp' | 'run_command' | 'parse_attachment' | 'self_correct';
  target: string;
  description: string;
  status: 'completed' | 'in_progress' | 'failed';
  result?: string;
  diff?: {
    added: string[];
    removed: string[];
  };
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'agent' | 'system';
  content: string;
  timestamp: string;
  attachments?: AttachmentFile[];
  agentSessionId?: string;
  thinkingLevel?: ThinkingLevel;
  thinkingProcess?: string;
  graphState?: LangGraphNodeState[];
  actions?: AgentAction[];
  lspDiagnostics?: LSPDiagnostic[];
  codeDiffs?: Array<{
    filePath: string;
    oldContent: string;
    newContent: string;
  }>;
  filePatches?: Array<{
    filePath: string;
    patch: string;
    additions: number;
    deletions: number;
  }>;
  commandExecution?: {
    command: string;
    output: string;
    exitCode: number;
  };
}

export interface AgentSession {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'idle' | 'running' | 'paused' | 'stopped' | 'completed' | 'error';
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  assignedTask?: string;
  progress: number;
  logs: string[];
  currentLspDiagnostics: LSPDiagnostic[];
  isolatedWorkspaceFiles: Record<string, WorkspaceFile>;
}

export interface PrerequisiteStatus {
  name: string;
  category: 'runtime' | 'lsp' | 'agent_framework' | 'sandbox';
  installed: boolean;
  version: string;
  progress: number; // 0 - 100
  detail: string;
}

export interface SystemSettings {
  autoInstallDependencies: boolean;
  lspDiagnosticsOnType: boolean;
  autoFixLspErrors: boolean;
  maxParallelSessions: number;
  localDataOnly: boolean;
  customOllamaEndpoint: string;
}

export interface LongTermMemoryItem {
  id: string;
  category: 'convention' | 'fact' | 'architecture' | 'preference' | 'bug_note';
  key: string;
  value: string;
  source: 'auto_extracted' | 'user_defined' | 'workspace_scan';
  createdAt: string;
  lastAccessedAt?: string;
}

export interface ShortTermMemoryState {
  activeSessionId: string;
  activeFilePath?: string;
  activeDirectoryPath?: string;
  totalWorkspaceFiles: number;
  recentActionsCount: number;
  activeDiagnosticErrorsCount: number;
  lastExecutedCommand?: string;
  lastCommandOutputSnippet?: string;
  turnCount: number;
  currentObjective?: string;
}

export interface MemoryContextPayload {
  longTermMemories: LongTermMemoryItem[];
  shortTermMemory: ShortTermMemoryState;
  promptContextPreview?: string;
}

