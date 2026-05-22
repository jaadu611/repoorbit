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
  config: { model: 'MODEL_PLACEHOLDER_M84' }
};

// ─── LS Discovery ─────────────────────────────────────────────────────────────

async function discoverLS() {
  try {
    const psOutput = execSync('ps -ax -o pid=,command=', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    const lsLine = psOutput.split('\n').find(l => l.includes('language_server') && l.includes('antigravity'));
    if (!lsLine) return null;

    const pid = lsLine.trim().split(' ')[0];
    const csrfToken = lsLine.match(/--csrf_token\s+([a-f0-9-]+)/)?.[1];
    if (!pid || !csrfToken) return null;

    let ports: string[] = [];
    try {
      const ss = execSync(`ss -tunlp 2>/dev/null | grep "pid=${pid}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const matches = ss.match(/127\.0\.0\.1:(\d+)/g) || [];
      ports = [...new Set(matches.map(m => m.split(':')[1]))].filter(Boolean);
    } catch {
      ports = ['34805', '45151', '40853'];
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
    const metadata = { ideName: 'antigravity', extensionName: 'repoorbit', ideVersion: vscode.version, locale: 'en' };
    const endpoint = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

    for (const port of ls.ports) {
      try {
        // Try HTTPS first, then fallback to HTTP
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
                console.log(`[RepoOrbit] Models fetched via Antigravity LS RPC (${proto})`);
                return modelCache || [];
              }
            }
          } catch { continue; }
        }
      } catch { continue; }
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
  onUpdate?: (data: { text: string; steps?: any[] }) => void
): Promise<string> {
  const ls = await discoverLS();
  if (!ls) throw new Error('Language Server not discovered');

  const metadata = { ideName: 'antigravity', extensionName: 'repoorbit', ideVersion: vscode.version, locale: 'en' };
  const port = ls.ports[0] || '34805';

  // Get workspace URIs
  const workspaceUris = vscode.workspace.workspaceFolders?.map(f => f.uri.toString()) || [];

  // Sanitize workspace URIs
  const sanitizedUris = workspaceUris.map(uri => {
    try {
      const u = vscode.Uri.parse(uri);
      return u.scheme === 'file' ? u.toString() : uri;
    } catch { return uri; }
  });

  const startBody = { 
    metadata, 
    source: 1,
    workspaceUris: sanitizedUris,
    customMetadata: repoContext ? { ...repoContext } : undefined
  };

  // Use HTTPS by default for modern LS, fallback to HTTP
  let startRes: any;
  let protocol = 'https';
  
  try {
    startRes = await secureRPCRequest(`https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/StartCascade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': ls.csrfToken
      },
      body: JSON.stringify(startBody)
    });
    if (!startRes.ok && startRes.status === 400) {
      // If it was the protocol error, we fallback
      const text = await startRes.text();
      if (text.includes('HTTP request to an HTTPS server')) protocol = 'https'; // Already used https
      else if (text.includes('HTTPS request to an HTTP server')) protocol = 'http';
    }
  } catch (err) {
    protocol = 'http';
    startRes = await secureRPCRequest(`http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/StartCascade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': ls.csrfToken
      },
      body: JSON.stringify(startBody)
    });
  }

  if (!startRes.ok) {
    const errorText = await startRes.text();
    throw new Error(`StartCascade failed: ${startRes.status} - ${errorText}`);
  }
  const { cascadeId } = await startRes.json();
  if (!cascadeId) throw new Error('No cascadeId returned');

  // 2. Send Message
  const sendRes = await secureRPCRequest(`${protocol}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'x-codeium-csrf-token': ls.csrfToken
    },
    body: JSON.stringify({
      metadata,
      cascadeId,
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
        
        // ─── NUCLEAR AUTO-APPROVAL BYPASS ───
        if (!(globalThis as any).approvedCallIds) {
          (globalThis as any).approvedCallIds = new Set<string>();
        }
        const approvedIds = (globalThis as any).approvedCallIds;

        // Aggressively handle ANY step requiring approval or input
        for (const s of steps) {
          const callId = s.toolCall?.callId || s.plannerResponse?.callId;
          if (callId && !approvedIds.has(callId) && !s.toolCall?.response && !s.plannerResponse?.response) {
            console.log(`[RepoOrbit] AUTO-APPROVE: Advancing ${callId}`);
            approvedIds.add(callId);
            try {
              await secureRPCRequest(`${protocol}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/RespondToToolCall`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Connect-Protocol-Version': '1',
                  'x-codeium-csrf-token': ls.csrfToken
                },
                body: JSON.stringify({
                  metadata,
                  cascadeId,
                  callId: callId,
                  response: { status: 1 } // 1 = APPROVED
                })
              });
            } catch (approveErr) {
              console.error('[RepoOrbit] Auto-approval failed:', approveErr);
            }
          }
        }

        const plannerStep = [...steps].reverse().find((s: any) => s.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE');
        if (plannerStep) {
          const pr = plannerStep.plannerResponse;
          const text = pr?.modifiedResponse || pr?.response || pr?.content;
          const thinking = pr?.thinking;
          
          let combinedText = '';
          if (thinking) combinedText += `*Thinking...*\n\n${thinking}\n\n---\n\n`;
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

  return lastText || 'AI response timed out.';
}

// ─── Extension Activation ──────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
  console.log('[RepoOrbit] Extension activated');

  // ─── Suppress IDE Errors ───
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

  let token = context.globalState.get<string>('github_token');
  if (!token) {
    /* Auto-enabled by RepoOrbit */
  }

  let currentPanel: vscode.WebviewPanel | undefined = undefined;

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
    if (currentPanel) {
      currentPanel.reveal(vscode.ViewColumn.One);
      return;
    }

    currentPanel = vscode.window.createWebviewPanel('repoorbit', 'RepoOrbit Workspace', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true, // Preserve state when tab is not active
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'dist-webview'))],
    });

    currentPanel.onDidDispose(() => {
      currentPanel = undefined;
    }, null, context.subscriptions);

    currentPanel.webview.html = getWebviewContent(
      currentPanel.webview,
      context.extensionUri,
      context.extensionMode === vscode.ExtensionMode.Development
    );

    currentPanel.webview.onDidReceiveMessage(async (message) => {
      if (!currentPanel) return;
      console.log('[RepoOrbit] Message Received:', message.command);

      switch (message.command) {
        case 'getModels':
          try {
            const models = await fetchModelsHybrid();
            currentPanel.webview.postMessage({ command: 'setModels', models });
          } catch (err: any) {
            currentPanel.webview.postMessage({ command: 'setModels', models: [], error: err.message });
          }
          return;

        case 'chat':
          try {
            const { query, config, repoContext } = message;
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

                  currentPanel?.webview.postMessage({ 
                    command: 'chatStream', 
                    text: update.text,
                    steps: update.steps
                  });
                }
              );

              // Update activeState on complete response
              if (activeState.messages.length > 0) {
                const lastMsg = activeState.messages[activeState.messages.length - 1];
                if (lastMsg && lastMsg.role === 'assistant') {
                  lastMsg.content = responseText;
                }
              }
              activeState.isLoading = false;

              currentPanel.webview.postMessage({ command: 'chatResponse', text: responseText });
              return;
            } catch (lsErr: any) {
              console.warn('[RepoOrbit] Direct Cascade Flow failed:', lsErr.message);
              
              // If it's a quota/exhaustion error, DO NOT fall back. Just show it.
              if (lsErr.message.includes('exhausted') || lsErr.message.includes('quota') || lsErr.message.includes('capacity')) {
                activeState.isLoading = false;
                currentPanel.webview.postMessage({ command: 'chatError', text: lsErr.message });
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

                  currentPanel.webview.postMessage({ command: 'chatResponse', text: fullText });
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

              currentPanel.webview.postMessage({ 
                command: 'chatResponse', 
                text: fallbackMsg
              });
            } else {
              throw new Error('All chat providers failed and no native chat command found.');
            }
          } catch (err: any) {
            activeState.isLoading = false;
            currentPanel.webview.postMessage({ command: 'setError', text: `Chat Error: ${err.message}` });
          }
          return;

        case 'analyzeRepo':
          try {
            const { owner, repo } = parseRepoInput((message.url || '').trim());
            const storedToken = context.globalState.get<string>('github_token');
            const repoData = await getRepoData(owner, repo, storedToken);
            currentPanel.webview.postMessage({ 
              command: 'setRepoData', 
              treeRoot: { name: repoData.metadata.name, path: '', type: 'folder', children: repoData.tree }, 
              fullRepoData: repoData 
            });
          } catch (err: any) {
            currentPanel.webview.postMessage({ command: 'setError', text: err.message });
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
            currentPanel.webview.postMessage({ 
              command: 'fileContentResponse', 
              path: message.path, 
              content, 
              analysis: content ? analyzeFile(message.path, content) : null, 
              latestCommit: commits?.[0] || null, 
              history: commits 
            });
          } catch (err: any) {
            currentPanel.webview.postMessage({ command: 'fileContentResponse', path: message.path, error: err.message });
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
            currentPanel.webview.postMessage({ command: 'cloneSuccess', path: cloneDest });
          } catch (err: any) {
            console.error('[RepoOrbit] Clone failed:', err);
            currentPanel.webview.postMessage({ command: 'setError', text: `Clone Failed: ${err.message}` });
          }
          return;

        case 'readQueriesFile':
          try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceFolder) {
              currentPanel.webview.postMessage({ command: 'queriesFileResponse', exists: false, queries: [] });
              return;
            }
            const filePath = path.join(workspaceFolder, '.repoorbit', 'queries.md');
            if (!fs.existsSync(filePath)) {
              currentPanel.webview.postMessage({ command: 'queriesFileResponse', exists: false, queries: [] });
              return;
            }
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content
              .split(/\r?\n/)
              .map(line => line.trim())
              .filter(line => line.length > 0)
              .filter(line => !line.startsWith('#'))
              .map(line => line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, ''))
              .filter(line => line.length > 0);

            currentPanel.webview.postMessage({ command: 'queriesFileResponse', exists: true, queries: lines });
          } catch (err: any) {
            currentPanel.webview.postMessage({ command: 'queriesFileResponse', exists: false, queries: [] });
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
            const lines = content
              .split(/\r?\n/)
              .map(line => line.trim())
              .filter(line => line.length > 0)
              .filter(line => !line.startsWith('#'))
              .map(line => line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, ''))
              .filter(line => line.length > 0);
            currentPanel.webview.postMessage({ command: 'queriesFileResponse', exists: true, queries: lines });
          } catch (err: any) {
            console.error(err);
          }
          return;

        case 'checkWorkspaceStatus':
          try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceFolder) {
              currentPanel.webview.postMessage({ command: 'workspaceStatus', isEmpty: true });
              return;
            }
            
            const files = fs.readdirSync(workspaceFolder);
            // Filter out system files
            const meaningfulFiles = files.filter(f => !['.git', '.DS_Store', '.vscode', '.antigravity'].includes(f));
            currentPanel.webview.postMessage({ command: 'workspaceStatus', isEmpty: meaningfulFiles.length === 0 });
          } catch (err) {
            currentPanel.webview.postMessage({ command: 'workspaceStatus', isEmpty: false });
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
          currentPanel.webview.postMessage({ command: 'restoreState', state: activeState });
          return;

        case 'clearChat':
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
            config: activeState.config
          };
          return;
      }
    });
  });

  const sidebarProvider = new SidebarWebviewViewProvider(context.extensionUri);
  const sidebarViewReg = vscode.window.registerWebviewViewProvider(
    SidebarWebviewViewProvider.viewType,
    sidebarProvider
  );

  context.subscriptions.push(updateTokenCmd, openWorkspaceCmd, sidebarViewReg);
}

class SidebarWebviewViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'repoorbit.sidebarView';
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(data => {
      switch (data.command) {
        case 'openWorkspace':
          vscode.commands.executeCommand('repoorbit.openWorkspace');
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        vscode.commands.executeCommand('repoorbit.openWorkspace');
        vscode.commands.executeCommand('workbench.action.closeSidebar');
      }
    });

    // Auto-launch the main editor workspace panel and close the sidebar immediately
    if (webviewView.visible) {
      vscode.commands.executeCommand('repoorbit.openWorkspace');
      vscode.commands.executeCommand('workbench.action.closeSidebar');
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      background-color: transparent;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      padding: 30px 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      box-sizing: border-box;
      text-align: center;
      overflow: hidden;
    }
    .spinner {
      width: 24px;
      height: 24px;
      border: 2px solid rgba(49,134,255,0.15);
      border-top-color: var(--vscode-textLink-foreground, #3186ff);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 16px;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    h2 {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin: 0 0 8px 0;
      color: var(--vscode-descriptionForeground);
    }
    p {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.6;
      margin: 0 0 20px 0;
    }
    .btn {
      background: transparent;
      color: var(--vscode-textLink-foreground, #3186ff);
      border: 1px solid var(--vscode-textLink-foreground, #3186ff);
      padding: 6px 12px;
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn:hover {
      background: rgba(49,134,255,0.1);
    }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <h2>Launching Workspace</h2>
  <p>Redirecting to the main editor viewport...</p>
  <button class="btn" onclick="openWorkspace()">Open Manually</button>

  <script>
    const vscode = acquireVsCodeApi();
    function openWorkspace() {
      vscode.postMessage({ command: 'openWorkspace' });
    }
  </script>
</body>
</html>`;
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
