import os from 'os';
import { execFile } from 'child_process';

export interface GpuInfo {
  vendor: 'nvidia' | 'amd' | 'apple' | 'unknown' | 'none';
  name: string;
  vramMB: number;
}

export interface SystemProfile {
  platform: string;
  cpuModel: string;
  cpuCores: number;
  totalRamMB: number;
  availableRamMB: number;
  gpus: GpuInfo[];
  totalVramMB: number;
  /** Rough estimate of the largest safe context window (tokens) for a local model */
  recommendedContextTokens: number;
  acceleration: 'cuda' | 'metal' | 'rocm' | 'cpu';
}

function probeNvidia(): Promise<GpuInfo[]> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve([]);
        const gpus: GpuInfo[] = stdout
          .trim()
          .split('\n')
          .map((line) => {
            const [name, mem] = line.split(',').map((s) => s.trim());
            return { vendor: 'nvidia' as const, name, vramMB: parseInt(mem, 10) || 0 };
          })
          .filter((g) => g.name);
        resolve(gpus);
      }
    );
  });
}

function probeAmd(): Promise<GpuInfo[]> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    // Windows: query via PowerShell CIM (no external tool needed)
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', "(Get-CimInstance Win32_VideoController | Where-Object {$_.AdapterRAM -gt 0} | ForEach-Object { $_.Name + ',' + [math]::Round($_.AdapterRAM / 1MB) }) -join ';'"],
      { timeout: 8000 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve([]);
        const gpus: GpuInfo[] = stdout
          .trim()
          .split(';')
          .map((entry) => {
            const [name, mem] = entry.split(',').map((s) => s.trim());
            const lower = (name || '').toLowerCase();
            const vendor = lower.includes('nvidia')
              ? ('nvidia' as const)
              : lower.includes('amd') || lower.includes('radeon')
                ? ('amd' as const)
                : ('unknown' as const);
            return { vendor, name: name || 'GPU', vramMB: parseInt(mem, 10) || 0 };
          });
        resolve(gpus.filter((g) => !g.name.toLowerCase().includes('basic')));
      }
    );
  });
}

let cachedProfile: SystemProfile | null = null;

export async function getSystemProfile(forceRefresh = false): Promise<SystemProfile> {
  if (cachedProfile && !forceRefresh) return cachedProfile;

  let gpus = await probeNvidia();
  if (!gpus.length) gpus = await probeAmd();

  // Apple Silicon unified memory acts as VRAM
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    gpus = [{ vendor: 'apple', name: 'Apple Silicon GPU', vramMB: Math.round(os.totalmem() / (1024 * 1024) * 0.7) }];
  }

  const totalVramMB = gpus.reduce((sum, g) => sum + g.vramMB, 0);
  const totalRamMB = Math.round(os.totalmem() / (1024 * 1024));
  const availableRamMB = Math.round(os.freemem() / (1024 * 1024));

  const acceleration: SystemProfile['acceleration'] =
    gpus.some((g) => g.vendor === 'nvidia')
      ? 'cuda'
      : gpus.some((g) => g.vendor === 'apple')
        ? 'metal'
        : gpus.some((g) => g.vendor === 'amd')
          ? 'rocm'
          : 'cpu';

  // Context sizing heuristic:
  // - KV cache + weights must fit; leave headroom. Rough tokens-per-VRAM-GB
  //   varies by model size, but as a scheduling heuristic:
  //   cuda/metal: ~2k tokens per VRAM GB, clamped 4k..64k
  //   cpu/rocm: bounded by RAM, ~1k tokens per RAM GB, clamped 2k..32k
  let recommendedContextTokens: number;
  if (acceleration === 'cuda' || acceleration === 'metal') {
    recommendedContextTokens = Math.min(65536, Math.max(4096, totalVramMB / 1024 * 2048));
  } else {
    recommendedContextTokens = Math.min(32768, Math.max(2048, availableRamMB / 1024 * 1024));
  }
  recommendedContextTokens = Math.round(recommendedContextTokens / 1024) * 1024;

  cachedProfile = {
    platform: `${process.platform} ${process.arch}`,
    cpuModel: os.cpus()[0]?.model || 'unknown',
    cpuCores: os.cpus().length,
    totalRamMB,
    availableRamMB,
    gpus,
    totalVramMB,
    recommendedContextTokens,
    acceleration
  };
  return cachedProfile;
}
