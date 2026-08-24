import { AIModel } from '../types';

export const DEFAULT_LOCAL_MODEL: AIModel = {
  id: 'local-auto-detected',
  name: 'Local System LLM (Auto-Detecting...)',
  provider: 'Local',
  isOpenSource: true,
  isFree: true,
  contextWindow: 'Dynamic Local RAM',
  supportsVision: true,
  supportsPdf: true,
  description: 'Select the Model Selector and press "Auto-Scan PC" to discover downloaded local models (Ollama, LM Studio).',
  recommendedFor: 'Private offline code execution and air-gapped agent work.'
};

export const SUPPORTED_MODELS: AIModel[] = [DEFAULT_LOCAL_MODEL];

export function createLocalModelObject(
  modelId: string,
  details?: { size?: number; family?: string; parameter_size?: string; provider?: string; endpoint?: string }
): AIModel {
  const cleanName = modelId
    .split('/')
    .pop()
    ?.replace(/:latest$/, '')
    ?.replace(/-/g, ' ')
    ?.replace(/\b\w/g, (l) => l.toUpperCase()) || modelId;

  const sizeStr = details?.size
    ? `${(details.size / (1024 * 1024 * 1024)).toFixed(1)} GB`
    : (details?.parameter_size || 'Local Memory');

  return {
    id: modelId,
    name: `${cleanName} (${sizeStr})`,
    provider: 'Ollama / Local',
    isOpenSource: true,
    isFree: true,
    contextWindow: `Local (${details?.family || 'System RAM'})`,
    supportsVision: modelId.toLowerCase().includes('vision') || modelId.toLowerCase().includes('llava') || modelId.toLowerCase().includes('moondream'),
    supportsPdf: true,
    description: `Downloaded local model detected on user system (${modelId}). Running 100% locally on localhost.`,
    recommendedFor: `Private local code generation using user's downloaded local model.`,
    endpoint: details?.endpoint
  };
}

