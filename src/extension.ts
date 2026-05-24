import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import {
  getRepoData,
  parseRepoInput,
  fetchFileContent,
  fetchCommitsForPath,
  analyzeFile,
} from './lib/core/github';
import {
  MASTER_MD_CONTENT,
  DEFAULT_QUERIES_CONTENT,
} from './lib/core/constants';
import { REVIEWER_SYSTEM_PROMPT } from './lib/core/prompt';
import { RepoOrbitExecutor } from './lib/core/executor';

// ─── Constants & State ────────────────────────────────────────────────────────
let modelCache: Array<{ id: string; name: string; vendor?: string; quota?: string | number }> | null = null;
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface PersistentState {
  messages: any[];
  isPlaying: boolean;
  currentQueryIndex: number;
  retryCount: number;
  isLoading: boolean;
  repoUrl: string;
  forkOwner: string;
  upstreamOwner: string;
  upstreamRepo: string;
  branchName: string;
  defaultBranch: string;
  config: { model: string };
  isCreatingPR?: boolean;
}

let activeState: PersistentState = {
  messages: [],
  isPlaying: false,
  currentQueryIndex: -1,
  retryCount: 0,
  isLoading: false,
  repoUrl: '',
  forkOwner: '',
  upstreamOwner: '',
  upstreamRepo: '',
  branchName: '',
  defaultBranch: '',
  config: { model: 'MODEL_PLACEHOLDER_M84' },
  isCreatingPR: false
};

let currentWebview: vscode.Webview | undefined = undefined;
let activeCascadeId: string | null = null;
let activeReviewCascadeId: string | null = null;

// ─── LS Discovery ─────────────────────────────────────────────────────────────

async function discoverLS() {
  try {
    const psOutput = execSync('ps -ax -o pid=,command=', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    const lines = psOutput.split('\n');
    
    // Prioritize Antigravity 2.0 standalone language server
    let lsLine = lines.find(l => l.includes('language_server') && l.includes('antigravity') && l.includes('--standalone'));
    if (!lsLine) {
      // Fallback to default IDE language server
      lsLine = lines.find(l => l.includes('language_server') && l.includes('antigravity'));
    }
    if (!lsLine) return null;

    const pid = lsLine.trim().split(' ')[0];
    const csrfToken = lsLine.match(/--csrf_token\s+([a-f0-9-]+)/)?.[1];
    if (!pid || !csrfToken) return null;

    let ports: string[] = [];
    try {
      const ss = execSync(`ss -lntp 2>/dev/null | grep "pid=${pid},"` , { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const matches = ss.match(/127\.0\.0\.1:(\d+)/g) || [];
      ports = [...new Set(matches.map(m => m.split(':')[1]))].filter(Boolean);
    } catch {
      try {
        const ss = execSync(`ss -tunlp 2>/dev/null | grep "pid=${pid}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        const matches = ss.match(/127\.0\.0\.1:(\d+)/g) || [];
        ports = [...new Set(matches.map(m => m.split(':')[1]))].filter(Boolean);
      } catch {
        ports = ['41833', '41107', '34805', '45151', '40853'];
      }
    }

    return { pid, csrfToken, ports };
  } catch (err) {
    console.error('[RepoOrbit] LS Discovery failed:', err);
    return null;
  }
}

// ─── Secure RPC Helper ────────────────────────────────────────────────────────

async function secureRPCRequest(url: string, options: any): Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }> {
  const https = require('https');
  const http = require('http');

  const u = new URL(url);
  const protocol = u.protocol === 'https:' ? https : http;
  
  const requestOptions = {
    hostname: u.hostname,
    port: u.port,
    path: u.pathname + u.search,
    method: options.method || 'GET',
    headers: options.headers || {},
    rejectUnauthorized: false // Bypasses local self-signed certs
  };

  return new Promise((resolve, reject) => {
    const req = protocol.request(requestOptions, (res: any) => {
      let data = '';
      res.on('data', (chunk: any) => data += chunk);
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(data),
          text: async () => data
        });
      });
    });

    req.on('error', (err: any) => reject(err));
    if (options.body) req.write(options.body);
    req.end();
  });
}

interface WorkingLSEndpoint {
  protocol: string;
  port: string;
}

let cachedWorkingEndpoint: WorkingLSEndpoint | null = null;
let cachedEndpointExpiry = 0;
const ENDPOINT_TTL = 30 * 1000; // 30 seconds cache

async function getWorkingLSEndpoint(ls: { ports: string[], csrfToken: string }): Promise<WorkingLSEndpoint | null> {
  if (cachedWorkingEndpoint && Date.now() < cachedEndpointExpiry) {
    return cachedWorkingEndpoint;
  }

  const metadata = { ideName: 'antigravity', extensionName: 'repoorbit', ideVersion: vscode.version, locale: 'en' };
  const endpoint = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

  for (const port of ls.ports) {
    for (const proto of ['https', 'http']) {
      try {
        const res = await secureRPCRequest(`${proto}://127.0.0.1:${port}${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': ls.csrfToken
          },
          body: JSON.stringify({ metadata })
        });
        if (res.ok) {
          cachedWorkingEndpoint = { protocol: proto, port };
          cachedEndpointExpiry = Date.now() + ENDPOINT_TTL;
          return cachedWorkingEndpoint;
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

// ─── Hybrid Model Fetcher ──────────────────────────────────────────────────────

async function fetchModelsHybrid(): Promise<Array<{ id: string; name: string; vendor?: string; quota?: string | number }>> {
  if (modelCache && Date.now() < cacheExpiry) return modelCache;

  // 1. Try official LM API first
  if (vscode.lm) {
    try {
      const lmModels = await (vscode as any).lm.selectChatModels({});
      if (lmModels.length > 0) {
        modelCache = lmModels.map((m: any) => ({
          id: m.id,
          name: m.name || m.id,
          vendor: m.vendor || 'Unknown'
        }));
        cacheExpiry = Date.now() + CACHE_TTL;
        console.log('[RepoOrbit] Models fetched via vscode.lm');
        return modelCache || [];
      }
    } catch (err) {
      console.warn('[RepoOrbit] vscode.lm model fetch failed:', err);
    }
  }

  // 2. Fallback: Direct RPC to Antigravity LS
  const ls = await discoverLS();
  if (ls) {
    const working = await getWorkingLSEndpoint(ls);
    if (working) {
      const metadata = { ideName: 'antigravity', extensionName: 'repoorbit', ideVersion: vscode.version, locale: 'en' };
      const endpoint = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

      try {
        const res = await secureRPCRequest(`${working.protocol}://127.0.0.1:${working.port}${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': ls.csrfToken
          },
          body: JSON.stringify({ metadata })
        });

        if (res.ok) {
          const data = await res.json();
          const cfgs = data?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
          if (cfgs?.length) {
            modelCache = cfgs.map((c: any) => {
              const lbl = c.label || c.modelOrAlias?.model || 'Unknown';
              const quota = c.quotaInfo?.remainingFraction ?? 'N/A';
              const resetTime = c.quotaInfo?.resetTime;
              return {
                id: c.modelOrAlias?.model || lbl,
                name: lbl,
                vendor: lbl.toLowerCase().includes('gemini') ? 'Google' : 
                        lbl.toLowerCase().includes('claude') ? 'Anthropic' : 
                        lbl.toLowerCase().includes('gpt') ? 'OpenAI' : 'Unknown',
                quota,
                resetTime
              };
            }).filter((m: any) => !m.name.toLowerCase().includes('internal'));
            cacheExpiry = Date.now() + CACHE_TTL;
            console.log(`[RepoOrbit] Models fetched via Antigravity LS RPC (${working.protocol})`);
            return modelCache || [];
          }
        }
      } catch (err: any) {
        console.warn('[RepoOrbit] fetchModelsHybrid direct RPC failed:', err.message);
      }
    }
  }

  // 3. Static fallback
  console.log('[RepoOrbit] Falling back to static model list');
  modelCache = [
    { id: 'MODEL_PLACEHOLDER_M16', name: 'Gemini 3.1 Pro (High)', vendor: 'Google' },
    { id: 'MODEL_PLACEHOLDER_M84', name: 'Gemini 3 Flash', vendor: 'Google' },
    { id: 'MODEL_PLACEHOLDER_M35', name: 'Claude Sonnet 4.6', vendor: 'Anthropic' },
    { id: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', name: 'GPT-OSS 120B', vendor: 'OpenAI' }
  ];
  cacheExpiry = Date.now() + CACHE_TTL;
  return modelCache;
}

// ─── Direct Cascade Chat Logic ────────────────────────────────────────────────

async function sendAntigravityChatDirect(
  query: string, 
  modelId: string, 
  repoContext?: any, 
  onUpdate?: (data: { text: string; steps?: any[] }) => void,
  useReviewSession?: boolean
): Promise<string> {
  const ls = await discoverLS();
  if (!ls) throw new Error('Language Server not discovered');

  const working = await getWorkingLSEndpoint(ls);
  if (!working) throw new Error('No working Language Server endpoint found');

  const metadata = { ideName: 'antigravity', extensionName: 'repoorbit', ideVersion: vscode.version, locale: 'en' };
  const port = working.port;
  const protocol = working.protocol;

  // Get workspace URIs
  const workspaceUris = vscode.workspace.workspaceFolders?.map(f => f.uri.toString()) || [];

  // Sanitize workspace URIs
  const sanitizedUris = workspaceUris.map(uri => {
    try {
      const u = vscode.Uri.parse(uri);
      return u.scheme === 'file' ? u.toString() : uri;
    } catch { return uri; }
  });

  let cascadeId = useReviewSession ? activeReviewCascadeId : activeCascadeId;
  let isNewCascade = false;

  const startNewCascade = async (): Promise<string> => {
    const startBody = { 
      metadata, 
      source: 1,
      workspaceUris: sanitizedUris,
      customMetadata: repoContext ? { ...repoContext } : undefined
    };

    const startRes = await secureRPCRequest(`${protocol}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/StartCascade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': ls.csrfToken
      },
      body: JSON.stringify(startBody)
    });

    if (!startRes.ok) {
      const errorText = await startRes.text();
      throw new Error(`StartCascade failed: ${startRes.status} - ${errorText}`);
    }
    const data = await startRes.json();
    if (!data.cascadeId) throw new Error('No cascadeId returned');
    return data.cascadeId;
  };

  if (!cascadeId) {
    cascadeId = await startNewCascade();
    if (useReviewSession) {
      activeReviewCascadeId = cascadeId;
    } else {
      activeCascadeId = cascadeId;
    }
    isNewCascade = true;
  }

  // Send Message function
  const sendMessage = async (cid: string) => {
    return await secureRPCRequest(`${protocol}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': ls.csrfToken
      },
      body: JSON.stringify({
        metadata,
        cascadeId: cid,
        items: [{ text: query }],
        clientType: 1,
        messageOrigin: 1,
        cascadeConfig: {
          plannerConfig: {
            conversational: { agenticMode: true }, 
            requestedModel: { model: modelId },
            toolConfig: {
              allowAllTools: true,
              autoRun: true
            }
          }
        }
      })
    });
  };

  let sendRes = await sendMessage(cascadeId);
  
  if (!sendRes.ok && !isNewCascade) {
    // Session might be dead/expired. Try starting a new cascade.
    console.log(`[RepoOrbit] Previous cascade ${cascadeId} send failed. Starting new cascade session...`);
    try {
      cascadeId = await startNewCascade();
      if (useReviewSession) {
        activeReviewCascadeId = cascadeId;
      } else {
        activeCascadeId = cascadeId;
      }
      sendRes = await sendMessage(cascadeId);
    } catch (newCascadeErr: any) {
      throw new Error(`Failed to restart cascade session: ${newCascadeErr.message}`);
    }
  }

  if (!sendRes.ok) {
    const errText = await sendRes.text();
    console.error(`[RepoOrbit] SendMessage failed with status ${sendRes.status}:`, errText);
    throw new Error(`SendMessage failed: ${sendRes.status} - ${errText}`);
  }

  // 3. Poll Trajectory
  console.log(`[RepoOrbit] Polling trajectory for cascade ${cascadeId}...`);
  let lastText = '';
  let pollCount = 0;
  
  while (true) { // Infinite polling
    pollCount++;
    await new Promise(r => setTimeout(r, 1000));
    try {
      const trajRes = await secureRPCRequest(`${protocol}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': ls.csrfToken
        },
        body: JSON.stringify({ metadata, cascadeId })
      });
      
      if (trajRes.ok) {
        const data = await trajRes.json() as any;
        const steps = data.trajectory?.steps || [];
        const status = data.status; // Top level status
        
        // Write complete trajectory data to debug file
        try {
          const os = require('os');
          const debugPath = path.join(os.tmpdir(), 'repoorbit-debug.json');
          fs.writeFileSync(debugPath, JSON.stringify({
            timestamp: new Date().toISOString(),
            status,
            trajectory: data.trajectory || data
          }, null, 2), 'utf8');
        } catch (writeErr) {}

        // Clean up legacy workspace debug file if it exists to avoid git clutter
        const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (wsFolder) {
          try {
            const legacyDebugPath = path.join(wsFolder, '.repoorbit-debug.json');
            if (fs.existsSync(legacyDebugPath)) {
              fs.unlinkSync(legacyDebugPath);
            }
          } catch (unlinkErr) {}
        }
        
        console.log(`[RepoOrbit] Trajectory Polled. Status: ${status}, Steps count: ${steps.length}`);
        if (steps.length > 0) {
          console.log(`[RepoOrbit] Steps detail: ${JSON.stringify(steps.map((s: any) => ({ type: s.type, toolCall: s.toolCall, plannerResponse: s.plannerResponse })))}`);
        }
        
        // ─── NUCLEAR AUTO-APPROVAL BYPASS ───
        if (!(globalThis as any).approvedCallIdsMap) {
          (globalThis as any).approvedCallIdsMap = new Map<string, { attempts: number, lastRunTime: number }>();
        }
        const approvedIdsMap = (globalThis as any).approvedCallIdsMap;

        if (!(globalThis as any).approvedInteractionKeysMap) {
          (globalThis as any).approvedInteractionKeysMap = new Map<string, { attempts: number, lastRunTime: number }>();
        }
        const approvedIntKeysMap = (globalThis as any).approvedInteractionKeysMap;

        // 1. Handle tool calls requiring approval
        for (const s of steps) {
          const toolCalls = s.plannerResponse?.toolCalls || [];
          for (const tc of toolCalls) {
            const callId = tc.id;
            if (callId) {
              let approvedData = approvedIdsMap.get(callId);
              let shouldBypass = false;

              if (!approvedData) {
                approvedData = { attempts: 1, lastRunTime: Date.now() };
                approvedIdsMap.set(callId, approvedData);
                shouldBypass = true;
                console.log(`[RepoOrbit] AUTO-APPROVE: Advancing tool call ${callId} (${tc.name}) - Attempt 1`);
              } else if (approvedData.attempts < 3 && Date.now() - approvedData.lastRunTime > 5000) {
                approvedData.attempts++;
                approvedData.lastRunTime = Date.now();
                shouldBypass = true;
                console.log(`[RepoOrbit] AUTO-APPROVE: Retrying tool call ${callId} (${tc.name}) - Attempt ${approvedData.attempts}`);
              }

              if (shouldBypass) {
                if (tc.name === 'run_command') {
                  try {
                    const args = JSON.parse(tc.argumentsJson || '{}');
                    const command = args.CommandLine;
                    if (command) {
                      console.log(`[RepoOrbit] Auto-approving command execution: ${command}`);
                    }
                  } catch (err) {
                    console.error('[RepoOrbit] Failed to parse command arguments:', err);
                  }
                }

                RepoOrbitExecutor.bypassConfirmation();
              }
            }
          }
        }

        // 2. Handle steps waiting for user interaction (explicit approval)
        for (const s of steps) {
          const info = s.metadata?.sourceTrajectoryStepInfo || s.metadata?.source_trajectory_step_info;
          const trajectoryId = info?.trajectoryId || info?.trajectory_id;
          const stepIndex = info?.stepIndex !== undefined ? info.stepIndex : info?.step_index;

          if (trajectoryId && stepIndex !== undefined) {
            const key = `${trajectoryId}_${stepIndex}`;
            
            const reqInt = s.requestedInteraction || s.requested_interaction;
            const hasRequestedInt = reqInt && (reqInt.interaction || Object.keys(reqInt).length > 0);
            const isWaiting = s.status === 3 || s.status === 'WAITING' || s.status === 'CASCADE_STEP_STATUS_WAITING' || hasRequestedInt;

            const approvedData = approvedIntKeysMap.get(key);
            const isFirstTime = !approvedData;
            const isStuck = approvedData && approvedData.attempts < 3 && (Date.now() - approvedData.lastRunTime > 5000);

            if (isWaiting && (isFirstTime || isStuck)) {
              console.log(`[RepoOrbit] Found waiting step ${stepIndex} in trajectory ${trajectoryId}. Checking for interaction... (Attempt ${approvedData ? approvedData.attempts + 1 : 1})`);
              console.log(`[RepoOrbit] DETAILED WAITING STEP:\n${JSON.stringify(s, null, 2)}`);

              try {
                const os = require('os');
                const debugPath = path.join(os.tmpdir(), 'repoorbit-step-waiting.json');
                fs.writeFileSync(debugPath, JSON.stringify({
                  key,
                  timestamp: new Date().toISOString(),
                  step: s
                }, null, 2), 'utf8');
              } catch (writeErr) {
                // ignore
              }

              let interactionValue: any = null;
              let interactionCase: string | null = null;

              // Find step case and value (plain JSON oneof representation vs helper class)
              let stepCase = '';
              let stepValue: any = null;
              if (s.step) {
                if (s.step.case && s.step.value) {
                  stepCase = s.step.case;
                  stepValue = s.step.value;
                } else {
                  const keys = Object.keys(s.step);
                  if (keys.length > 0) {
                    stepCase = keys[0];
                    stepValue = s.step[keys[0]];
                  }
                }
              }

              // Find requested interaction case (plain JSON oneof representation vs helper class)
              let intCase = '';
              if (reqInt) {
                const intObj = reqInt.interaction || reqInt;
                if (intObj.case && intObj.value) {
                  intCase = intObj.case;
                } else {
                  const keys = Object.keys(intObj);
                  if (keys.length > 0) {
                    intCase = keys[0];
                  }
                }
              }

              // Check for filePermissionRequest inside step/stepValue/step status
              let filePermissionUri = '';
              const filePermReq = s.step?.value?.filePermissionRequest || s.step?.value?.file_permission_request ||
                                  stepValue?.filePermissionRequest || stepValue?.file_permission_request ||
                                  s.filePermissionRequest || s.file_permission_request;
              if (filePermReq) {
                filePermissionUri = filePermReq.absolutePathUri || filePermReq.absolute_path_uri || '';
              }

              if (filePermissionUri) {
                interactionCase = 'filePermission';
                interactionValue = {
                  allow: true,
                  scope: 1, // ONCE
                  absolutePathUri: filePermissionUri,
                  absolute_path_uri: filePermissionUri
                };
              } else if (intCase) {
                interactionCase = intCase;
                switch (intCase) {
                  case 'runCommand':
                  case 'run_command':
                    const cmd = stepCase === 'runCommand' || stepCase === 'run_command'
                      ? (stepValue?.commandLine || stepValue?.command_line || '')
                      : '';
                    interactionValue = {
                      confirm: true,
                      proposedCommandLine: cmd,
                      proposed_command_line: cmd,
                      submittedCommandLine: cmd,
                      submitted_command_line: cmd
                    };
                    break;
                  case 'openBrowserUrl':
                  case 'open_browser_url':
                  case 'captureBrowserScreenshot':
                  case 'capture_browser_screenshot':
                  case 'executeBrowserJavascript':
                  case 'execute_browser_javascript':
                  case 'mcp':
                  case 'readUrlContent':
                  case 'read_url_content':
                    interactionValue = {
                      confirm: true
                    };
                    break;
                  case 'permission':
                    interactionValue = {
                      allow: true,
                      scope: 2 // PERSIST/WORKSPACE
                    };
                    break;
                  default:
                    console.warn(`[RepoOrbit] Unknown interaction case: ${intCase}`);
                    break;
                }
              }

              if (interactionCase && interactionValue) {
                // Delete duplicate/internal keys to avoid unmarshaling / duplicate field errors in language server gRPC
                delete interactionValue.cascadeId;
                delete interactionValue.cascade_id;
                delete interactionValue.trajectoryId;
                delete interactionValue.trajectory_id;

                console.log(`[RepoOrbit] AUTO-APPROVE: Sending interaction ${interactionCase} for step ${stepIndex}`);

                RepoOrbitExecutor.bypassConfirmation();

                let normalizedCase = interactionCase;
                if (interactionCase === 'run_command') normalizedCase = 'runCommand';
                else if (interactionCase === 'file_permission') normalizedCase = 'filePermission';
                else if (interactionCase === 'open_browser_url') normalizedCase = 'openBrowserUrl';
                else if (interactionCase === 'capture_browser_screenshot') normalizedCase = 'captureBrowserScreenshot';
                else if (interactionCase === 'execute_browser_javascript') normalizedCase = 'executeBrowserJavascript';
                else if (interactionCase === 'read_url_content') normalizedCase = 'readUrlContent';

                let anySuccess = false;
                let lastErrText = '';
                
                const indicesToSend: number[] = [];
                if (stepIndex !== undefined) {
                  indicesToSend.push(stepIndex);
                  if (stepIndex > 0) indicesToSend.push(stepIndex - 1);
                  indicesToSend.push(stepIndex + 1);
                }
                for (let i = 0; i < steps.length; i++) {
                  if (!indicesToSend.includes(i)) {
                    indicesToSend.push(i);
                  }
                }
                if (!indicesToSend.includes(steps.length)) {
                  indicesToSend.push(steps.length);
                }

                for (const idx of indicesToSend) {
                  try {
                    const res = await secureRPCRequest(`${protocol}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/HandleCascadeUserInteraction`, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'Connect-Protocol-Version': '1',
                        'x-codeium-csrf-token': ls.csrfToken
                      },
                      body: JSON.stringify({
                        metadata,
                        cascadeId,
                        interaction: {
                          trajectoryId,
                          stepIndex: idx,
                          [normalizedCase]: interactionValue
                        }
                      })
                    });

                    if (res.ok) {
                      console.log(`[RepoOrbit] HandleCascadeUserInteraction succeeded for step ${idx}`);
                      anySuccess = true;
                      break;
                    } else {
                      lastErrText = await res.text();
                      console.warn(`[RepoOrbit] HandleCascadeUserInteraction attempt failed for step ${idx}:`, lastErrText);
                    }
                  } catch (interactionErr: any) {
                    lastErrText = interactionErr.message;
                    console.warn(`[RepoOrbit] HandleCascadeUserInteraction attempt error for step ${idx}:`, lastErrText);
                  }
                }

                if (anySuccess) {
                  if (isFirstTime) {
                    approvedIntKeysMap.set(key, { attempts: 1, lastRunTime: Date.now() });
                  } else if (approvedData) {
                    approvedData.attempts++;
                    approvedData.lastRunTime = Date.now();
                  }
                } else {
                  console.error(`[RepoOrbit] HandleCascadeUserInteraction failed for all candidate step indices. Last error: ${lastErrText}`);
                }
              } else {
                console.log(`[RepoOrbit] Step ${stepIndex} is waiting but no programmatic interaction case identified. Bypassing UI confirmation...`);
                RepoOrbitExecutor.bypassConfirmation();
                if (isFirstTime) {
                  approvedIntKeysMap.set(key, { attempts: 1, lastRunTime: Date.now() });
                } else if (approvedData) {
                  approvedData.attempts++;
                  approvedData.lastRunTime = Date.now();
                }
              }
            }
          }
        }


        const plannerStep = [...steps].reverse().find((s: any) => s.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE');
        if (plannerStep) {
          const pr = plannerStep.plannerResponse;
          const text = pr?.modifiedResponse || pr?.response || pr?.content;
          
          let combinedText = '';
          if (text) combinedText += text;

          if (combinedText && combinedText !== lastText) {
            lastText = combinedText;
            if (onUpdate) onUpdate({ text: lastText, steps });
          }
        }

        if ((status === 'CASCADE_RUN_STATUS_IDLE' || status === 2) && lastText) {
          return lastText;
        }
        
        // If an error step appeared, fail fast and DO NOT continue polling
        if (steps.some((s: any) => s.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE')) {
          const errStep = steps.find((s: any) => s.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE');
          const errorMsg = errStep?.errorMessage?.error?.userErrorMessage || 
                           errStep?.errorMessage?.error?.shortError ||
                           errStep?.errorMessage?.message || 
                           'Cascade encountered an error';
          throw new Error(errorMsg);
        }
      }
    } catch (pollErr: any) {
      console.warn(`[RepoOrbit] Poll attempt ${pollCount} result:`, pollErr.message);
      // If it's a quota error, throw it immediately to break the loop
      if (pollErr.message.includes('exhausted') || pollErr.message.includes('quota') || pollErr.message.includes('capacity')) {
        throw pollErr;
      }
      // Otherwise continue polling (transient network issues etc)
    }
  }

}

function parseQueries(content: string): any[] {
  const parts = content.split(/^\s*---\s*$/m);
  const queries: any[] = [];

  let i = 0;
  if (parts[0] !== undefined && parts[0].trim() === "") {
    i = 1;
  }

  while (i < parts.length) {
    const section = parts[i]?.trim() || "";
    if (section.toLowerCase().includes("github-issue:")) {
      const metadata: Record<string, string> = {};
      const lines = section.split(/\r?\n/);
      for (const line of lines) {
        const colonIndex = line.indexOf(":");
        if (colonIndex !== -1) {
          const key = line.substring(0, colonIndex).trim().toLowerCase();
          const value = line.substring(colonIndex + 1).trim();
          metadata[key] = value;
        }
      }
      const bodyPart = parts[i + 1] || "";
      queries.push({
        query: bodyPart.trim(),
        "github-issue": metadata["github-issue"] || "",
      });
      i += 2;
    } else {
      if (section) {
        queries.push({
          query: section,
          "github-issue": "",
        });
      }
      i += 1;
    }
  }

  return queries;
}

function appendReviewLog(workspaceFolder: string, logEntry: any) {
  try {
    const logFilePath = path.join(workspaceFolder, '.repoorbit-logs.json');
    let logs: any[] = [];
    if (fs.existsSync(logFilePath)) {
      try {
        logs = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
        if (!Array.isArray(logs)) {
          logs = [];
        }
      } catch {
        logs = [];
      }
    }
    logs.push(logEntry);
    fs.writeFileSync(logFilePath, JSON.stringify(logs, null, 2), 'utf8');
  } catch (err: any) {
    console.error('[RepoOrbit] Failed to write review log:', err.message);
  }
}

async function handleWebviewMessage(webview: vscode.Webview, message: any, context: vscode.ExtensionContext) {
  console.log('[RepoOrbit] Message Received:', message.command);

  switch (message.command) {
    case 'getModels':
      try {
        const models = await fetchModelsHybrid();
        webview.postMessage({ command: 'setModels', models });
      } catch (err: any) {
        webview.postMessage({ command: 'setModels', models: [], error: err.message });
      }
      return;

    case 'chat':
      try {
        const { query, config, repoContext, session } = message;
        const modelId = config.model;
        console.log(`[RepoOrbit] AI Chat Request [Model: ${modelId}]:`, query);

        activeState.isLoading = true;
        activeState.config = config;

        // 1. Try Direct Cascade Flow (Best UX, response stays in RepoOrbit)
        try {
          const responseText = await sendAntigravityChatDirect(
            query, 
            modelId, 
            repoContext,
            (update) => {
              // Update activeState in host
              if (activeState.messages.length > 0) {
                const lastMsg = activeState.messages[activeState.messages.length - 1];
                if (lastMsg && lastMsg.role === 'assistant') {
                  lastMsg.content = update.text;
                  lastMsg.steps = update.steps;
                } else {
                  activeState.messages.push({
                    role: 'assistant',
                    content: update.text,
                    steps: update.steps
                  });
                }
              } else {
                activeState.messages.push({
                  role: 'assistant',
                  content: update.text,
                  steps: update.steps
                });
              }

              currentWebview?.postMessage({ 
                command: 'chatStream', 
                text: update.text,
                steps: update.steps
              });
            },
            session === 'review'
          );

          // Update activeState on complete response
          if (activeState.messages.length > 0) {
            const lastMsg = activeState.messages[activeState.messages.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.content = responseText;
            }
          }
          activeState.isLoading = false;

          webview.postMessage({ command: 'chatResponse', text: responseText });
          return;
        } catch (lsErr: any) {
          console.warn('[RepoOrbit] Direct Cascade Flow failed:', lsErr.message);
          
          // If it's a quota/exhaustion error, DO NOT fall back. Just show it.
          if (lsErr.message.includes('exhausted') || lsErr.message.includes('quota') || lsErr.message.includes('capacity')) {
            activeState.isLoading = false;
            webview.postMessage({ command: 'chatError', text: lsErr.message });
            return;
          }
          
          console.log('[RepoOrbit] Trying fallbacks for non-quota error...');
        }

        // 2. Try vscode.lm API
        if (vscode.lm) {
          try {
            const models = await (vscode as any).lm.selectChatModels({ family: modelId.includes('gemini') ? 'gemini' : undefined });
            const model = models.find((m: any) => m.id === modelId) || models[0];
            if (model) {
              const request = [new (vscode as any).LanguageModelUserMessage(query)];
              const lmResponse = await model.sendRequest(request, {}, new vscode.CancellationTokenSource().token);
              let fullText = '';
              for await (const fragment of lmResponse.text) {
                fullText += fragment;
              }
              
              // Update activeState in host
              if (activeState.messages.length > 0) {
                const lastMsg = activeState.messages[activeState.messages.length - 1];
                if (lastMsg && lastMsg.role === 'assistant') {
                  lastMsg.content = fullText;
                }
              }
              activeState.isLoading = false;

              webview.postMessage({ command: 'chatResponse', text: fullText });
              return;
            }
          } catch (lmErr) {
            console.warn('[RepoOrbit] vscode.lm fallback failed:', lmErr);
          }
        }

        // 3. Last Resort: Forward to Native Chat Panel
        const cmds = await vscode.commands.getCommands(true);
        const chatCmd = cmds.find(c => c.includes('antigravity') && c.includes('chat')) || 
                       cmds.find(c => c.includes('chat.focus'));
        
        if (chatCmd) {
          console.log('[RepoOrbit] Forwarding to discovered command:', chatCmd);
          await vscode.commands.executeCommand(chatCmd, query);
          
          const fallbackMsg = '🚀 Direct API call failed. Prompt forwarded to the native Antigravity Chat panel.';
          if (activeState.messages.length > 0) {
            const lastMsg = activeState.messages[activeState.messages.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.content = fallbackMsg;
            }
          }
          activeState.isLoading = false;

          webview.postMessage({ 
            command: 'chatResponse', 
            text: fallbackMsg
          });
        } else {
          throw new Error('All chat providers failed and no native chat command found.');
        }
      } catch (err: any) {
        activeState.isLoading = false;
        webview.postMessage({ command: 'setError', text: `Chat Error: ${err.message}` });
      }
      return;

    case 'analyzeRepo':
      try {
        const { owner, repo } = parseRepoInput((message.url || '').trim());
        const storedToken = context.globalState.get<string>('github_token');
        const repoData = await getRepoData(owner, repo, storedToken);
        webview.postMessage({ 
          command: 'setRepoData', 
          treeRoot: { name: repoData.metadata.name, path: '', type: 'folder', children: repoData.tree }, 
          fullRepoData: repoData 
        });
      } catch (err: any) {
        webview.postMessage({ command: 'setError', text: err.message });
      }
      return;

    case 'getFileContent':
      try {
        const { owner, repo } = parseRepoInput((message.url || '').trim());
        const storedToken = context.globalState.get<string>('github_token');
        const [content, commits] = await Promise.all([
          fetchFileContent(owner, repo, message.path, message.branch || 'main', storedToken),
          fetchCommitsForPath(owner, repo, message.path, storedToken)
        ]);
        webview.postMessage({ 
          command: 'fileContentResponse', 
          path: message.path, 
          content, 
          analysis: content ? analyzeFile(message.path, content) : null, 
          latestCommit: commits?.[0] || null, 
          history: commits 
        });
      } catch (err: any) {
        webview.postMessage({ command: 'fileContentResponse', path: message.path, error: err.message });
      }
      return;

    case 'cloneRepo':
      try {
        const { url, path: targetPath } = message;
        // Resolve path relative to workspace if not absolute
        let fullPath = targetPath;
        if (!path.isAbsolute(targetPath)) {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (workspaceFolder) {
            fullPath = path.join(workspaceFolder, targetPath);
          } else {
            fullPath = path.join(process.cwd(), targetPath);
          }
        }

        console.log(`[RepoOrbit] Cloning ${url} into ${fullPath}...`);
        
        // Always use the path provided by the user exactly
        let cloneDest = fullPath;

        const parentDir = path.dirname(cloneDest);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        if (fs.existsSync(cloneDest)) {
          const stats = fs.statSync(cloneDest);
          if (stats.isDirectory()) {
            const files = fs.readdirSync(cloneDest);
            if (files.length > 0) {
              throw new Error(`Destination path "${cloneDest}" is not empty.`);
            }
          }
        }

        execSync(`git clone ${url} "${cloneDest}"`, { stdio: 'inherit' });
        
        // --- BOOTSTRAP INITIALIZATION ---
        // Create .agents/rules/MASTER.md
        try {
          const agentsRulesDir = path.join(cloneDest, '.agents', 'rules');
          if (!fs.existsSync(agentsRulesDir)) {
            fs.mkdirSync(agentsRulesDir, { recursive: true });
          }
          const masterPath = path.join(agentsRulesDir, 'MASTER.md');
          if (!fs.existsSync(masterPath)) {
            fs.writeFileSync(masterPath, MASTER_MD_CONTENT);
          }

          // Create .repoorbit/queries.md
          const repoorbitDir = path.join(cloneDest, '.repoorbit');
          if (!fs.existsSync(repoorbitDir)) {
            fs.mkdirSync(repoorbitDir, { recursive: true });
          }
          const queriesPath = path.join(repoorbitDir, 'queries.md');
          if (!fs.existsSync(queriesPath)) {
            fs.writeFileSync(queriesPath, DEFAULT_QUERIES_CONTENT);
          }
        } catch (bootstrapErr) {
          console.error('[RepoOrbit] Failed to bootstrap rules/queries:', bootstrapErr);
        }
        // ---------------------------------

        vscode.window.showInformationMessage(`RepoOrbit: Cloned ${url} successfully!`);
        activeCascadeId = null;
        webview.postMessage({ command: 'cloneSuccess', path: cloneDest });
      } catch (err: any) {
        console.error('[RepoOrbit] Clone failed:', err);
        webview.postMessage({ command: 'setError', text: `Clone Failed: ${err.message}` });
      }
    case 'runReview':
      try {
        const { queryIndex, queryText, attempts } = message;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) {
          throw new Error('No workspace folder open');
        }

        // Request code review from LLM
        console.log('[RepoOrbit] Requesting LLM code review via Chat 2...');
        
        // Find the github-issue link for the current query
        const queriesPath = path.join(workspaceFolder, '.repoorbit', 'queries.md');
        let githubIssue = '';
        if (fs.existsSync(queriesPath)) {
          try {
            const content = fs.readFileSync(queriesPath, 'utf8');
            const queries = parseQueries(content);
            const q = queries[queryIndex];
            if (q) {
              githubIssue = q['github-issue'] || q.githubIssue || '';
            }
          } catch (err) {
            console.error('[RepoOrbit] Failed to read github issue for reviewer:', err);
          }
        }

        let combinedReviewPrompt = `${REVIEWER_SYSTEM_PROMPT}\n\nOriginal Query/Goal: ${queryText}`;
        if (githubIssue) {
          combinedReviewPrompt += `\nGitHub Issue Reference: Reference ${githubIssue}. Retrieve all linked issues, pull requests, and discussions using the GitHub CLI/API (\`gh issue view\` or \`gh api\`). Filter out conversational noise, duplicate comments, "+1" reactions, and meta-discussions to isolate core technical requirements, reproduction details, and error logs. You MUST implement and verify code fixes for the main issue and all linked/related issues.`;
        }
        const modelId = activeState.config.model || 'MODEL_PLACEHOLDER_M84';
        let reviewJsonText = '';
        let reviewRating = 3;
        let reviewFeedback = 'Failed to generate review.';

        try {
          reviewJsonText = await sendAntigravityChatDirect(
            combinedReviewPrompt,
            modelId,
            undefined,
            undefined,
            true // useReviewSession = true
          );
        } catch (lsErr: any) {
          console.error('[RepoOrbit] Direct RPC review failed:', lsErr.message);
          throw lsErr;
        }

        if (reviewJsonText) {
          let cleaned = reviewJsonText.trim();
          if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
          }
          cleaned = cleaned.trim();
          try {
            const parsed = JSON.parse(cleaned);
            reviewRating = Number(parsed.rating);
            reviewFeedback = parsed.feedback || '';
          } catch (parseErr) {
            console.error('[RepoOrbit] Failed to parse review JSON:', cleaned, parseErr);
            const ratingMatch = cleaned.match(/"rating"\s*:\s*(\d)/);
            const feedbackMatch = cleaned.match(/"feedback"\s*:\s*"(.*)"/s);
            if (ratingMatch) {
              reviewRating = Number(ratingMatch[1]);
            }
            if (feedbackMatch) {
              reviewFeedback = feedbackMatch[1];
            }
          }
        }

        console.log(`[RepoOrbit] Review rating received: ${reviewRating}/5`);

        appendReviewLog(workspaceFolder, {
          queryIndex,
          queryText,
          rating: reviewRating,
          feedback: reviewFeedback,
          attempts,
          timestamp: new Date().toISOString()
        });

        if (reviewRating === 5 || attempts >= 3) {
          try {
            console.log('[RepoOrbit] Committing changes...');
            execSync('git add -A', { cwd: workspaceFolder });
            execSync(`git commit -m "fix: ${queryText.slice(0, 50).replace(/"/g, '\\"')}"`, { cwd: workspaceFolder });
            console.log('[RepoOrbit] Commit successful!');
          } catch (commitErr: any) {
            console.error('[RepoOrbit] Git commit failed:', commitErr.message);
          }
        }

        webview.postMessage({
          command: 'reviewResponse',
          rating: reviewRating,
          feedback: reviewFeedback,
          attempts
        });

      } catch (err: any) {
        console.error('[RepoOrbit] runReview error:', err);
        webview.postMessage({
          command: 'reviewResponse',
          error: err.message,
          attempts: message.attempts || 1
        });
      }
      return;

    case 'readQueriesFile':
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) {
          webview.postMessage({ command: 'queriesFileResponse', exists: false, queries: [] });
          return;
        }
        const filePath = path.join(workspaceFolder, '.repoorbit', 'queries.md');
        if (!fs.existsSync(filePath)) {
          webview.postMessage({ command: 'queriesFileResponse', exists: false, queries: [] });
          return;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        const queries = parseQueries(content);

        webview.postMessage({ command: 'queriesFileResponse', exists: true, queries });
      } catch (err: any) {
        webview.postMessage({ command: 'queriesFileResponse', exists: false, queries: [] });
      }
      return;

    case 'createQueriesFile':
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) return;
        const repoorbitDir = path.join(workspaceFolder, '.repoorbit');
        if (!fs.existsSync(repoorbitDir)) {
          fs.mkdirSync(repoorbitDir, { recursive: true });
        }
        const queriesPath = path.join(repoorbitDir, 'queries.md');
        if (!fs.existsSync(queriesPath)) {
          fs.writeFileSync(queriesPath, DEFAULT_QUERIES_CONTENT);
        }
        // Trigger readQueriesFile immediately after creation
        const content = fs.readFileSync(queriesPath, 'utf8');
        const queries = parseQueries(content);
        webview.postMessage({ command: 'queriesFileResponse', exists: true, queries });
      } catch (err: any) {
        console.error(err);
      }
      return;

    case 'checkWorkspaceStatus':
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) {
          webview.postMessage({ command: 'workspaceStatus', isEmpty: true });
          return;
        }
        
        const files = fs.readdirSync(workspaceFolder);
        // Filter out system files
        const meaningfulFiles = files.filter(f => !['.git', '.DS_Store', '.vscode', '.antigravity'].includes(f));
        webview.postMessage({ command: 'workspaceStatus', isEmpty: meaningfulFiles.length === 0 });
      } catch (err) {
        webview.postMessage({ command: 'workspaceStatus', isEmpty: false });
      }
      return;

    case 'saveToken':
      await context.globalState.update('github_token', message.token);
      vscode.window.showInformationMessage('RepoOrbit: Token saved!');
      return;

    case 'syncState':
      if (message.state) {
        activeState = { ...activeState, ...message.state };
      }
      return;

    case 'getStoredState':
      webview.postMessage({ command: 'restoreState', state: activeState });
      return;

    case 'clearChat':
      activeCascadeId = null;
      activeState = {
        messages: [],
        isPlaying: false,
        currentQueryIndex: -1,
        retryCount: 0,
        isLoading: false,
        repoUrl: activeState.repoUrl,
        forkOwner: '',
        upstreamOwner: '',
        upstreamRepo: '',
        branchName: '',
        defaultBranch: '',
        config: activeState.config,
        isCreatingPR: false
      };
      return;
  }
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('[RepoOrbit] Extension activated');

  vscode.commands.getCommands(true).then(cmds => {
    try {
      const os = require('os');
      const cmdsPath = path.join(os.tmpdir(), 'vscode-commands.json');
      fs.writeFileSync(cmdsPath, JSON.stringify(cmds, null, 2), 'utf8');
      console.log('[RepoOrbit] Logged registered commands to', cmdsPath);
    } catch (e) {}
  });

  // ─── Suppress IDE Errors ───
  const appName = vscode.env.appName.toLowerCase();
  const isAntigravityIDE = appName.includes('antigravity') || appName.includes('cider') || appName.includes('jetski');
  const hasAntigravityExt = vscode.extensions.getExtension('google.antigravity') || 
                            vscode.extensions.all.some(ext => ext.id.toLowerCase().includes('antigravity'));

  if (!isAntigravityIDE && !hasAntigravityExt) {
    try {
      const registeredCommands = await vscode.commands.getCommands(true);
      if (!registeredCommands.includes('antigravity.isFileGitIgnored')) {
        try {
          const isFileGitIgnoredCmd = vscode.commands.registerCommand('antigravity.isFileGitIgnored', async (uri: vscode.Uri) => {
            try {
              const fsPath = uri.fsPath;
              const repoPath = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
              if (!repoPath) return false;
              const relativePath = path.relative(repoPath, fsPath);
              const output = execSync(`git check-ignore "${relativePath}"`, { cwd: repoPath, encoding: 'utf8' }).trim();
              return !!output;
            } catch {
              return false;
            }
          });

          context.subscriptions.push(isFileGitIgnoredCmd);
        } catch (regErr: any) {
          console.warn('[RepoOrbit] Failed to register command antigravity.isFileGitIgnored:', regErr.message);
        }
      }
    } catch (err: any) {
      console.warn('[RepoOrbit] Failed to retrieve registered commands for antigravity.isFileGitIgnored:', err.message);
    }
  }

  let token = context.globalState.get<string>('github_token');
  if (!token) {
    /* Auto-enabled by RepoOrbit */
  }

  const updateTokenCmd = vscode.commands.registerCommand('repoorbit.updateToken', async () => {
    const newToken = await vscode.window.showInputBox({
      prompt: 'Enter new GitHub Personal Access Token',
      placeHolder: 'ghp_...',
      password: true,
    });
    if (newToken) {
      await context.globalState.update('github_token', newToken);
      vscode.window.showInformationMessage('RepoOrbit: Token updated!');
    }
  });

  const openWorkspaceCmd = vscode.commands.registerCommand('repoorbit.openWorkspace', () => {
    // Focus the RepoOrbit activity bar sidebar container and view
    vscode.commands.executeCommand('workbench.view.extension.repoorbit-sidebar-container');
    vscode.commands.executeCommand('repoorbit.sidebarView.focus');
  });

  const sidebarProvider = new SidebarWebviewViewProvider(
    context.extensionUri,
    context.extensionMode === vscode.ExtensionMode.Development,
    context
  );
  const sidebarViewReg = vscode.window.registerWebviewViewProvider(
    SidebarWebviewViewProvider.viewType,
    sidebarProvider
  );

  context.subscriptions.push(updateTokenCmd, openWorkspaceCmd, sidebarViewReg);
}

class SidebarWebviewViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'repoorbit.sidebarView';

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _isDev: boolean,
    private readonly _context: vscode.ExtensionContext
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this._extensionUri.fsPath, 'dist-webview'))]
    };

    webviewView.webview.html = getWebviewContent(
      webviewView.webview,
      this._extensionUri,
      this._isDev
    );

    currentWebview = webviewView.webview;

    webviewView.webview.onDidReceiveMessage(async (message) => {
      await handleWebviewMessage(webviewView.webview, message, this._context);
    });

    webviewView.onDidDispose(() => {
      if (currentWebview === webviewView.webview) {
        currentWebview = undefined;
      }
    });
  }
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri, isDev: boolean): string {
  if (isDev) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: blob: data:; style-src ${webview.cspSource} 'unsafe-inline' http://localhost:5173; script-src 'unsafe-inline' 'unsafe-eval' http://localhost:5173; connect-src http://localhost:5173 ws://localhost:5173 http://127.0.0.1:*;">
  <title>RepoOrbit Dev</title>
  <script type="module">
    import { injectIntoGlobalHook } from "http://localhost:5173/@react-refresh";
    injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
  </script>
  <script type="module" src="http://localhost:5173/@vite/client"></script>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;color:white;">
  <div id="root"></div>
  <script type="module" src="http://localhost:5173/src/main.tsx"></script>
</body>
</html>`;
  }

  const distPath = vscode.Uri.joinPath(extensionUri, 'dist-webview');
  const indexHtmlPath = path.join(distPath.fsPath, 'index.html');
  if (!fs.existsSync(indexHtmlPath)) return "<h1>Build missing. Run `npm run ext:build-ui`</h1>";
  
  let html = fs.readFileSync(indexHtmlPath, 'utf8');
  const assetUri = webview.asWebviewUri(distPath);
  
  // Inject CSP
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: blob: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-eval' 'unsafe-inline'; connect-src https: http: ws: wss:;">`;
  html = html.replace('<head>', `<head>\n    ${csp}`);

  html = html.replace(/(href|src)="\/assets\//g, `$1="${assetUri}/assets/`).replace(/(href|src)="\//g, `$1="${assetUri}/`);
  return html;
}

export function deactivate() {}
